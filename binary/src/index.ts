process.env.IS_BINARY = "true";
import { Command } from "commander";
import { Core } from "core/core";
import { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { IMessenger } from "core/util/messenger";
import { getCoreLogsPath } from "core/util/paths";
import fs from "node:fs";
import { IpcIde } from "./IpcIde";
import { setupCa } from "./ca";
import { Core } from "./core";
import { IpcMessenger } from "./messenger";

const logFilePath = getCoreLogsPath();
fs.appendFileSync(logFilePath, "[info] Starting Continue core...\n");

const program = new Command();

program.action(async () => {
  try {
    let messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>;
    if (process.env.CONTINUE_DEVELOPMENT === "true") {
      messenger = new TcpMessenger<ToCoreProtocol, FromCoreProtocol>();
      console.log("Waiting for connection");
      await (
        messenger as TcpMessenger<ToCoreProtocol, FromCoreProtocol>
      ).awaitConnection();
      console.log("Connected");
    } else {
      messenger = new IpcMessenger<ToCoreProtocol, FromCoreProtocol>();
    }
    const ide = new IpcIde(messenger);
    const core = new Core(messenger, ide);

    setupCa();

    // setTimeout(() => {
    //   messenger.mock({
    //     messageId: "2fe7823c-10bd-4771-abb5-781f520039ec",
    //     messageType: "loadSubmenuItems",
    //     data: { title: "issue" },
    //   });
    // }, 1000);
  } catch (e) {
    fs.writeFileSync("./error.log", `${new Date().toISOString()} ${e}\n`);
    console.log("Error: ", e);
    process.exit(1);
  }
});

program.parse(process.argv);
