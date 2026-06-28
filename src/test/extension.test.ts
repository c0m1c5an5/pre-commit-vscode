import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const EXTENSION_ID = "c0m1c5an5.pre-commit-vscode";

// Compiled tests live at out/test/; two levels up reaches the project root.
const FIXTURES_DIR = path.join(__dirname, "..", "..", "src", "test", "fixtures");

let workspaceDir: string;

// Resolves with document text once predicate returns true on onDidChangeTextDocument.
function waitForDocumentText(
  doc: vscode.TextDocument,
  predicate: (text: string) => boolean,
  timeoutMs = 90_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (predicate(doc.getText())) {
      resolve(doc.getText());
      return;
    }
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error("Timeout: document text did not satisfy predicate"));
    }, timeoutMs);
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== doc.uri.toString()) {
        return;
      }
      const text = e.document.getText();
      if (predicate(text)) {
        clearTimeout(timer);
        sub.dispose();
        resolve(text);
      }
    });
  });
}

// Inserts a comment at position 0 to dirty the buffer without triggering
// trimFinalNewlines / trimTrailingWhitespace at end-of-file on save.
async function openAndDirty(filePath: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(0, 0), "# dirty-marker\n");
  await vscode.workspace.applyEdit(edit);
  return doc;
}

// Saves doc and asserts the buffer is not modified by the extension.
async function assertNoBufferChange(doc: vscode.TextDocument): Promise<void> {
  const initialText = doc.getText();
  // Drain any deferred onDidChangeTextDocument events from openAndDirty before
  // registering the listener to avoid false positives.
  await new Promise<void>((r) => setTimeout(r, 100));
  let changed = false;
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (
      e.document.uri.toString() === doc.uri.toString() &&
      e.contentChanges.length > 0
    ) {
      changed = true;
    }
  });
  await doc.save();
  await new Promise<void>((r) => setTimeout(r, 3000));
  sub.dispose();
  assert.strictEqual(changed, false, "Buffer must not change");
  assert.strictEqual(doc.getText(), initialText);
}

suite("pre-commit extension E2E", () => {
  suiteSetup(async () => {
    workspaceDir = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(
      ext,
      `Extension ${EXTENSION_ID} not found — is it installed in the test runner?`,
    );
    await ext.activate();
  });

  suiteTeardown(() => {
    const samplePath = path.join(workspaceDir, "sample.py");
    if (fs.existsSync(samplePath)) {
      fs.unlinkSync(samplePath);
    }
  });

  test("trailing-whitespace hook removes trailing spaces on save", async () => {
    const filePath = path.join(workspaceDir, "sample.py");
    fs.writeFileSync(filePath, "x = 1   \ny = 2\n");

    const doc = await openAndDirty(filePath);
    const changed = waitForDocumentText(doc, (t) => !t.includes("x = 1   "));
    await doc.save();
    const finalText = await changed;

    assert.strictEqual(
      finalText,
      "# dirty-marker\nx = 1\ny = 2\n",
      `Unexpected buffer content: ${JSON.stringify(finalText)}`,
    );
  });

  test("does not modify buffer when no format hooks present", async () => {
    const isolated = fs.mkdtempSync(
      path.join(os.tmpdir(), "pre-commit-nofmt-"),
    );
    try {
      fs.cpSync(path.join(FIXTURES_DIR, "nofmt"), isolated, { recursive: true });
      const filePath = path.join(isolated, "test.py");
      fs.writeFileSync(filePath, "y = 2\n");
      const doc = await openAndDirty(filePath);
      await assertNoBufferChange(doc);
    } finally {
      fs.rmSync(isolated, { recursive: true });
    }
  });

  test("does not modify buffer when no config file found", async () => {
    const isolated = fs.mkdtempSync(
      path.join(os.tmpdir(), "pre-commit-noconf-"),
    );
    try {
      const filePath = path.join(isolated, "test.py");
      fs.writeFileSync(filePath, "z = 3\n");
      const doc = await openAndDirty(filePath);
      await assertNoBufferChange(doc);
    } finally {
      fs.rmSync(isolated, { recursive: true });
    }
  });
});
