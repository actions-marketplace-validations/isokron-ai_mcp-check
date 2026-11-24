// For test/oracles.test.mjs (R-ORC-05): a server that answers nothing and writes bytes with no line break, forever.
const chunk = Buffer.alloc(64 * 1024, 0x61);
const go = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', go); };
go();
