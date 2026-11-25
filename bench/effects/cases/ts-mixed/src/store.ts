import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.NOTES_DIR ?? './notes';

export async function readNote(id: string): Promise<string> {
  return fs.readFile(path.join(ROOT, id + '.md'), 'utf8');
}

export async function listNotes(): Promise<string[]> {
  return fs.readdir(ROOT);
}

// Two levels down from a handler: handler -> persist -> writeNote -> fs.writeFile
export async function writeNote(id: string, body: string): Promise<void> {
  await fs.writeFile(path.join(ROOT, id + '.md'), body);
}

export async function persist(id: string, body: string): Promise<void> {
  await writeNote(id, body);
}

export async function dropNote(id: string): Promise<void> {
  await fs.unlink(path.join(ROOT, id + '.md'));
}
