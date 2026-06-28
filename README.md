# pre-commit-vscode

Runs your pre-commit format hooks on save, acting as a VS Code formatter backed by pre-commit.

## How it works

On every file save the extension:

1. Walks up the directory tree to find `.pre-commit-config.yaml`
2. Identifies hooks whose `alias` contains the word `format` (e.g.
   `format-prettier`, `prettier_format`)
3. Passes all other hooks in `SKIP=...` so only the format hooks run
4. Runs `pre-commit run --files <file>`
5. If pre-commit modified the file, reloads the buffer

Non-zero exit codes are written to the **pre-commit** Output Channel (View →
Output).

## Marking hooks as format hooks

Add an `alias` containing `format` to any hook you want to run on save:

```yaml
repos:
  - repo: https://github.com/psf/black
    rev: 24.3.0
    hooks:
      - id: black
        alias: format-black
  - repo: https://github.com/pycqa/flake8
    rev: 7.0.0
    hooks:
      - id: flake8
        alias: format-flake8
```

## Suppressing conflicting formatters (e.g. Prettier)

This extension registers itself as a VS Code formatter. To prevent another
formatter from running on the same file type, set it as the default formatter in
your workspace settings:

```json
{
  "[python]": { "editor.defaultFormatter": "pre-commit-vscode" }
}
```

## Extension Settings

| Setting                            | Default        | Description                             |
|------------------------------------|----------------|-----------------------------------------|
| `pre-commit-vscode.executablePath` | `"pre-commit"` | Path to the pre-commit executable       |
| `pre-commit-vscode.timeout`        | `60`           | Seconds before killing a pre-commit run |

## Requirements

`pre-commit` must be installed and available on `PATH` (or configure
`executablePath`).
