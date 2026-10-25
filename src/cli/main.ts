import { Jailor } from "../runtime/jailor.js";
import { HostProcessBackend } from "../runtime/backends/host-process.js";
import os from "node:os";
import path from "node:path";

function getBaseDir(): string {
  return process.env.ENVIA_HOME ?? path.join(os.homedir(), ".envia");
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function getAllOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) values.push(args[i + 1]);
  }
  return values;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  } else {
    process.stdout.write(String(value) + "\n");
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = hasFlag(args, "--json");
  const baseDir = getBaseDir();
  const allowUnsafe = hasFlag(args, "--unsafe-host-process") || process.env.ENVIA_ALLOW_HOST_PROCESS_BACKEND === "1";
  const backend = new HostProcessBackend({ baseDir, allowUnsafeHostProcess: allowUnsafe });
  const jailor = new Jailor(baseDir, backend);
  await jailor.init();

  const [group, command, ...rest] = args.filter((a) => a !== "--json");

  if (group === "system" && command === "doctor") {
    print({ baseDir, capabilities: jailor.capabilities() }, json);
    return 0;
  }

  if (group === "runtime" && command === "capabilities") {
    print(jailor.capabilities(), json);
    return 0;
  }

  if (group === "jail" && command === "create") {
    const name = getOption(rest, "--name") ?? "jail";
    const commandToRun = getOption(rest, "--command");
    if (!commandToRun) {
      process.stderr.write("missing --command\n");
      return 2;
    }
    const isolationRequired = !hasFlag(rest, "--unsafe-host-process");
    const jail = await jailor.createJail({
      name,
      command: commandToRun,
      args: getAllOptions(rest, "--arg"),
      env: Object.fromEntries(
        getAllOptions(rest, "--env").map((entry) => {
          const split = entry.indexOf("=");
          return [entry.slice(0, split), entry.slice(split + 1)];
        })
      ),
      workingDirectory: getOption(rest, "--workdir"),
      isolationRequired,
      allowUnsafeHostProcess: hasFlag(rest, "--unsafe-host-process"),
    });
    print(jail, json);
    return 0;
  }

  if (group === "jail" && command === "list") {
    print(await jailor.listJails(), json);
    return 0;
  }

  if (group === "jail" && command === "inspect" && rest[0]) {
    print(await jailor.inspectJail(rest[0]), json);
    return 0;
  }

  if (group === "jail" && command === "start" && rest[0]) {
    const started = await jailor.startJail(rest[0]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const inspected = await jailor.inspectJail(rest[0]);
    print({ ...started, ...inspected }, json);
    return 0;
  }

  if (group === "jail" && command === "stop" && rest[0]) {
    print(await jailor.stopJail(rest[0]), json);
    return 0;
  }

  if (group === "jail" && command === "remove" && rest[0]) {
    await jailor.removeJail(rest[0]);
    print({ removed: rest[0] }, json);
    return 0;
  }

  if (group === "jail" && command === "logs" && rest[0]) {
    print(await jailor.logs(rest[0], Number(getOption(rest, "--lines") ?? 100)), json);
    return 0;
  }

  process.stderr.write("usage: envia <jail|system|runtime> ...\n");
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exit(1);
  });