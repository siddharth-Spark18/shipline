// Launcher for the hook scripts: `node .shipline/bin/run-hook.mjs <guard|session-start|prompt-submit|record-answer>`.
// Imports the named script; if that throws (a syntax error in lib.mjs, a missing file) or the script crashes later,
// the call fails open but says so, instead of silently turning every rule off. Imports nothing from lib.mjs, so it
// still works when lib.mjs is broken. Node 18+, no dependencies.
const NAMES = ['guard', 'session-start', 'prompt-submit', 'record-answer'];
const name = process.argv[2];

// Claude Code reads stdout as JSON only when it is exactly one object, so once the hook has printed anything the
// crash message goes to stderr instead.
let wrote = false;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  wrote = true;
  return write(chunk, ...rest);
};

function crashed(err) {
  const first = String((err && err.message) || err || 'unknown error').split(/\r?\n/)[0];
  const message = `Shipline ${name} hook crashed: ${first}. Its checks are off for this call; run \`npx @forgeyard/shipline upgrade\` or fix .shipline/bin.`;
  if (wrote) process.stderr.write(`${message}\n`);
  else write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
}

if (!NAMES.includes(name)) {
  write(JSON.stringify({ systemMessage: `Shipline run-hook: unknown hook "${name}"; its checks are off for this call. Run \`npx @forgeyard/shipline upgrade\`.` }));
  process.exit(0);
}

process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);
try {
  await import(`./${name}.mjs`);
} catch (err) {
  crashed(err);
}
