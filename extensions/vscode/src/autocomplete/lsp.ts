import type { IDE, RangeInFile } from "core";
import { getAst, getTreePathAtCursor } from "core/autocomplete/ast";
import type { AutocompleteSnippet } from "core/autocomplete/ranking";
import type { RangeInFileWithContents } from "core/commands/util";
import * as vscode from "vscode";
import type Parser from "web-tree-sitter";

type GotoProviderName =
  | "vscode.executeDefinitionProvider"
  | "vscode.executeTypeDefinitionProvider"
  | "vscode.executeDeclarationProvider"
  | "vscode.executeImplementationProvider"
  | "vscode.executeReferenceProvider";

interface GotoInput {
  uri: string;
  line: number;
  character: number;
  name: GotoProviderName;
}
function gotoInputKey(input: GotoInput) {
  return `${input.name}${input.uri.toString}${input.line}${input.character}`;
}

export async function getDefinitionsForNode(
  uri: string,
  node: Parser.SyntaxNode,
  ide: IDE,
  lang: AutocompleteLanguageInfo,
): Promise<RangeInFileWithContents[]> {
  const ranges: (RangeInFile | RangeInFileWithContents)[] = [];
  switch (node.type) {
    case "call_expression": {
      // function call -> function definition
      const [funDef] = await executeGotoProvider({
        uri,
        line: node.startPosition.row,
        character: node.startPosition.column,
        name: "vscode.executeDefinitionProvider",
      });
      if (!funDef) {
        return [];
      }

      // Don't display a function of more than 15 lines
      // We can of course do something smarter here eventually
      let funcText = await ide.readRangeInFile(funDef.filepath, funDef.range);
      if (funcText.split("\n").length > 15) {
        let truncated = false;
        const funRootAst = await getAst(funDef.filepath, funcText);
        if (funRootAst) {
          const [funNode] = findChildren(
            funRootAst?.rootNode,
            (node) => FUNCTION_DECLARATION_NODE_TYPEs.includes(node.type),
            1,
          );
          if (funNode) {
            const [statementBlockNode] = findChildren(
              funNode,
              (node) => FUNCTION_BLOCK_NODE_TYPES.includes(node.type),
              1,
            );
            if (statementBlockNode) {
              funcText = funRootAst.rootNode.text
                .slice(0, statementBlockNode.startIndex)
                .trim();
              truncated = true;
            }
          }
        }
        if (!truncated) {
          funcText = funcText.split("\n")[0];
        }
      }

      ranges.push(funDef);

      const typeDefs = await crawlTypes(
        {
          ...funDef,
          contents: funcText,
        },
        ide,
      );
      ranges.push(...typeDefs);
      break;
    }
    case "variable_declarator":
      // variable assignment -> variable definition/type
      // usages of the var that appear after the declaration
      break;
    case "impl_item":
      // impl of trait -> trait definition
      break;
    case "new_expression":
      // In 'new MyClass(...)', "MyClass" is the classNameNode
      const classNameNode = node.children.find(
        (child) => child.type === "identifier",
      );
      const [classDef] = await executeGotoProvider({
        uri,
        line: (classNameNode ?? node).endPosition.row,
        character: (classNameNode ?? node).endPosition.column,
        name: "vscode.executeDefinitionProvider",
      });
      if (!classDef) {
        break;
      }
      const contents = await ide.readRangeInFile(
        classDef.filepath,
        classDef.range,
      );

      ranges.push({
        ...classDef,
        contents: `${
          classNameNode?.text
            ? `${lang.singleLineComment} ${classNameNode.text}:\n`
            : ""
        }${contents.trim()}`,
      });

      const definitions = await crawlTypes({ ...classDef, contents }, ide);
      ranges.push(...definitions.filter(Boolean));

      break;
    case "":
      // function definition -> implementations?
      break;
  }
  return await Promise.all(
    ranges.map(async (rif) => {
      if (!isRifWithContents(rif)) {
        return {
          ...rif,
          contents: await ide.readRangeInFile(rif.filepath, rif.range),
        };
      }
      return rif;
    }),
  );
}

/**
 * and other stuff not directly on the path:
 * - variables defined on line above
 * ...etc...
 */

export const getDefinitionsFromLsp: GetLspDefinitionsFunction = async (
  filepath: string,
  contents: string,
  cursorIndex: number,
  ide: IDE,
): Promise<AutocompleteSnippet[]> {
  try {
    const ast = await getAst(filepath, contents);
    if (!ast) return [];

    const treePath = await getTreePathAtCursor(ast, cursorIndex);
    if (!treePath) return [];

    const results: RangeInFileWithContents[] = [];
    for (const node of treePath.reverse()) {
      const definitions = await getDefinitionsForNode(filepath, node);
      results.push(
        ...(await Promise.all(
          definitions.map(async (def) => ({
            ...def,
            contents: await ide.readRangeInFile(
              def.filepath,
              new vscode.Range(
                new vscode.Position(
                  def.range.start.line,
                  def.range.start.character,
                ),
                new vscode.Position(
                  def.range.end.line,
                  def.range.end.character,
                ),
              ),
            ),
          })),
        )),
      );
    }

    return results.map((result) => ({
      ...result,
      score: 0.8,
    }));
  } catch (e) {
    console.warn("Error getting definitions from LSP: ", e);
    return [];
  }
}
