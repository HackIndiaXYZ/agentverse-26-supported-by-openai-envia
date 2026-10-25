import { Jailor } from "../runtime/jailor.js";
import { HostProcessBackend } from "../runtime/backends/host-process.js";
import { ImageStore } from "../images/store.js";
import { ImageBuilder } from "../images/builder.js";
import { VolumeManager } from "../volumes/manager.js";
import { NetworkManager } from "../network/manager.js";
import { AgentRunManager } from "../agent/run-manager.js";
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

function parseMount(entry: string, volumeManager: VolumeManager): { source: string; target: string; readOnly: boolean } {
  let readOnly = false;
  let cleaned = entry;
  if (cleaned.endsWith(":ro")) {
    readOnly = true;
    cleaned = cleaned.slice(0, -3);
  }
  const idx = cleaned.indexOf("=");
  if (idx === -1) throw new Error(`invalid mount (expected source=target): ${entry}`);
  const sourceRaw = cleaned.slice(0, idx);
  const target = cleaned.slice(idx + 1);
  let source = sourceRaw;
  if (!path.isAbsolute(sourceRaw)) {
    try {
      // Treat an existing named volume as a volume mount.
      source = volumeManager.path(sourceRaw);
    } catch {
      source = path.resolve(process.cwd(), sourceRaw);
    }
  }
  if (!path.isAbsolute(source)) source = path.resolve(process.cwd(), source);
  return { source, target, readOnly };
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
  const imageStore = new ImageStore(baseDir);
  await imageStore.init();
  const volumeManager = new VolumeManager(baseDir);
  await volumeManager.init();
  const networkManager = new NetworkManager(baseDir);
  await networkManager.init();
  const agentRunManager = new AgentRunManager(baseDir, jailor, imageStore, allowUnsafe);
  await agentRunManager.init();

  const filteredArgs = args.filter((a) => a !== "--json");
  let group = filteredArgs[0];
  let command = filteredArgs[1];
  let rest = filteredArgs.slice(2);
  if (group === "run") {
    rest = [command, ...rest].filter((v) => v !== undefined) as string[];
    command = "run";
    group = "jail";
  }

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
    const mounts = [
      ...getAllOptions(rest, "--mount").map((entry) => parseMount(entry, volumeManager)),
      ...getAllOptions(rest, "--volume").map((entry) => {
        const idx = entry.indexOf("=");
        const name = entry.slice(0, idx);
        const target = entry.slice(idx + 1);
        return { source: volumeManager.path(name), target, readOnly: false };
      }),
    ];
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
      mounts,
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

  if (group === "build") {
    const positional: string[] = [];
    if (command && !command.startsWith("-")) positional.push(command);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith("-")) {
        if (rest[i] === "-t" || rest[i] === "--tag" || rest[i] === "--file" || rest[i] === "--build-arg") i++;
        continue;
      }
      positional.push(rest[i]);
    }
    const contextArg = positional[0] ?? ".";
    const contextDir = path.resolve(process.cwd(), contextArg);
    const tag = getOption(rest, "-t") ?? getOption(rest, "--tag");
    const file = getOption(rest, "--file");
    const buildArgs = Object.fromEntries(
      getAllOptions(rest, "--build-arg").map((entry) => {
        const idx = entry.indexOf("=");
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      })
    );
    const builder = new ImageBuilder(imageStore, { allowUnsafeHostProcess: allowUnsafe });
    const manifest = await builder.build({ contextDir, jailfilePath: file, tag, buildArgs, onLog: (line) => process.stderr.write(line + "\n") });
    print(tag ? { tag, digest: manifest.digest } : manifest, json);
    return 0;
  }

  if (group === "image" && (command === "list" || command === "ls")) {
    print(await imageStore.list(), json);
    return 0;
  }

  if (group === "image" && command === "inspect" && rest[0]) {
    print(await imageStore.inspect(rest[0]), json);
    return 0;
  }

  if (group === "image" && command === "tag" && rest[0] && rest[1]) {
    const digest = await imageStore.tag(rest[0], rest[1]);
    print({ tag: rest[1], digest }, json);
    return 0;
  }

  if (group === "image" && command === "rm" && rest[0]) {
    await imageStore.remove(rest[0]);
    print({ removed: rest[0] }, json);
    return 0;
  }

  if (group === "image" && command === "export" && rest[0] && rest[1]) {
    await imageStore.exportImage(rest[0], rest[1]);
    print({ exported: rest[0], path: rest[1] }, json);
    return 0;
  }

  if (group === "volume" && (command === "list" || command === "ls")) {
    print(await volumeManager.list(), json);
    return 0;
  }

  if (group === "volume" && command === "create" && rest[0]) {
    print(await volumeManager.create(rest[0]), json);
    return 0;
  }

  if (group === "volume" && command === "inspect" && rest[0]) {
    print(await volumeManager.inspect(rest[0]), json);
    return 0;
  }

  if (group === "network" && (command === "list" || command === "ls")) {
    print(await networkManager.list(), json);
    return 0;
  }

  if (group === "network" && command === "create" && rest[0]) {
    print(await networkManager.create(rest[0], getOption(rest, "--driver")), json);
    return 0;
  }

  if (group === "network" && command === "inspect" && rest[0]) {
    print(await networkManager.inspect(rest[0]), json);
    return 0;
  }

  if (group === "network" && command === "rm" && rest[0]) {
    await networkManager.remove(rest[0]);
    print({ removed: rest[0] }, json);
    return 0;
  }

  if (group === "agent" && (command === "list" || command === "ls")) {
    print(await agentRunManager.list(), json);
    return 0;
  }

  if (group === "agent" && command === "inspect" && rest[0]) {
    print(await agentRunManager.inspect(rest[0]), json);
    return 0;
  }

  if (group === "agent" && command === "approve" && rest[0]) {
    print(await agentRunManager.approve(rest[0]), json);
    return 0;
  }

  if (group === "agent" && command === "replay" && rest[0]) {
    print(await agentRunManager.replay(rest[0]), json);
    return 0;
  }

  if (group === "agent" && command === "run") {
    const task = getOption(rest, "--task") ?? "agent run";
    const commandToRun = getOption(rest, "--command");
    const args = getAllOptions(rest, "--arg");
    const env: Record<string, string> = {};
    for (const entry of getAllOptions(rest, "--env")) {
      const idx = entry.indexOf("=");
      if (idx !== -1) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    const spec = {
      task,
      image: getOption(rest, "--image"),
      command: commandToRun ?? "",
      args,
      env,
      workingDirectory: getOption(rest, "--workdir"),
      timeoutMs: getOption(rest, "--timeout") ? Number(getOption(rest, "--timeout")) : undefined,
      checkpoint: hasFlag(rest, "--checkpoint"),
    };
    const record = await agentRunManager.run(spec);
    print(record, json);
    return record.status === "succeeded" ? 0 : 1;
  }

  if (group === "volume" && command === "rm" && rest[0]) {
    await volumeManager.remove(rest[0]);
    print({ removed: rest[0] }, json);
    return 0;
  }

  if (group === "image" && command === "import" && rest[0]) {
    const digest = await imageStore.importImage(rest[0]);
    print({ imported: rest[0], digest }, json);
    return 0;
  }

  if (group === "jail" && command === "ps") {
    print(await jailor.listJails(), json);
    return 0;
  }

  if (group === "jail" && command === "rm" && rest[0]) {
    await jailor.removeJail(rest[0]);
    print({ removed: rest[0] }, json);
    return 0;
  }

  if (group === "jail" && command === "restart" && rest[0]) {
    print(await jailor.restartJail(rest[0]), json);
    return 0;
  }

  if (group === "jail" && command === "exec" && rest[0]) {
    const id = rest[0];
    let execCommand = getOption(rest, "--command");
    let execArgs = getAllOptions(rest, "--arg");
    if (!execCommand && rest[1] && !rest[1].startsWith("-")) {
      execCommand = rest[1];
      execArgs = rest.slice(2).filter((a) => !a.startsWith("-"));
    }
    if (!execCommand) {
      process.stderr.write("missing command for exec\n");
      return 2;
    }
    const timeoutMs = getOption(rest, "--timeout") ? Number(getOption(rest, "--timeout")) : undefined;
    const result = await jailor.execJail(id, execCommand, execArgs, { timeoutMs });
    print(result, json);
    return result.exitCode === 0 ? 0 : 1;
  }

  if (group === "jail" && command === "run") {
    const imageRef = getOption(rest, "--image") ?? rest.find((a) => !a.startsWith("-"));
    if (!imageRef) {
      process.stderr.write("missing image for run\n");
      return 2;
    }
    const name = getOption(rest, "--name") ?? imageRef.split(":")[0] ?? "jail";
    const commandOpt = getOption(rest, "--command");
    let imageManifest = null as any;
    let rootfsPath: string | undefined;
    let imageEnv: Record<string, string> = {};
    let imageCmd: string[] = [];
    try {
      const image = await imageStore.resolve(imageRef);
      imageManifest = image.manifest;
      rootfsPath = image.rootfsPath;
      for (const entry of image.manifest.config.env ?? []) {
        const idx = entry.indexOf("=");
        if (idx !== -1) imageEnv[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
      const fromConfig = image.manifest.config.entrypoint?.length
        ? image.manifest.config.entrypoint
        : image.manifest.config.cmd;
      if (Array.isArray(fromConfig)) imageCmd = fromConfig as string[];
    } catch (err) {
      // Allow running without an image ref by treating the argument as a jail name only if --command is provided.
      if (!commandOpt) throw err;
    }

    const commandToRun = commandOpt ?? imageCmd[0];
    if (!commandToRun) {
      process.stderr.write("missing --command and image has no CMD/ENTRYPOINT\n");
      return 2;
    }
    const args = getAllOptions(rest, "--arg").length > 0
      ? getAllOptions(rest, "--arg")
      : (commandOpt ? [] : imageCmd.slice(1));

    const env = { ...imageEnv };
    for (const entry of getAllOptions(rest, "--env")) {
      const idx = entry.indexOf("=");
      if (idx !== -1) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }

    const mounts = [
      ...getAllOptions(rest, "--mount").map((entry) => parseMount(entry, volumeManager)),
      ...getAllOptions(rest, "--volume").map((entry) => {
        const idx = entry.indexOf("=");
        const name = entry.slice(0, idx);
        const target = entry.slice(idx + 1);
        return { source: volumeManager.path(name), target, readOnly: false };
      }),
    ];
    const isolationRequired = !hasFlag(rest, "--unsafe-host-process");
    const jail = await jailor.createJail({
      name,
      command: commandToRun,
      args,
      env,
      workingDirectory: getOption(rest, "--workdir") ?? imageManifest?.config?.workingDir,
      mounts,
      limits: {},
      isolationRequired,
      allowUnsafeHostProcess: hasFlag(rest, "--unsafe-host-process"),
      rootfsPath,
    });
    const started = await jailor.startJail(jail.id);
    if (hasFlag(rest, "--detach") || hasFlag(rest, "-d")) {
      print(started, json);
      return 0;
    }
    const timeoutMs = getOption(rest, "--timeout") ? Number(getOption(rest, "--timeout")) : 60000;
    const deadline = Date.now() + timeoutMs;
    let current = started;
    while (current.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await jailor.inspectJail(jail.id);
    }
    print(current, json);
    return current.exitCode === 0 ? 0 : 1;
  }

  process.stderr.write("usage: envia <jail|system|runtime|build|image> ...\n");
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exit(1);
  });