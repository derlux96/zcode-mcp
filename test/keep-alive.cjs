// Preloaded (--require) into a server under test: a referenced timer keeps its event
// loop busy, like a hung reaper pass would, so the server can only end through its
// own exit once stdin closes.
setInterval(() => {}, 1 << 30);
