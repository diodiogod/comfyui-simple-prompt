# ComfyUI Simple Prompt
<p align="center">
  <img src="https://github.com/user-attachments/assets/401bd9f1-045e-4840-8bc7-683020461fa3"
       alt="image"
       width="480" />
</p>

A focused ComfyUI custom node for writing positive and negative prompts as strings and keeping a permanent, searchable prompt library.

Simple Prompt was originally extracted from the `Simple Prompt` work in **PG-Nodes**. It has since become an independent project with its own storage, cross-tab synchronization, history interface, search behavior, and variation grouping. This package intentionally contains only this prompt node, not the other PG-Nodes nodes.

## Node

### Simple Prompt (Standalone)

Inputs:

- Positive prompt
- Negative prompt

Outputs:

- Positive prompt as a `STRING`
- Negative prompt as a `STRING`

Prompts are saved only after the node runs as part of a workflow. Merely typing or editing text does not create history entries.

## Prompt Library

- Keeps every executed prompt without a configured history limit.
- Shares one package-local history database across nodes and browser tabs.
- Refreshes open History panels when the database changes.
- Searches positive prompts, negative prompts, and custom entry names.
- Supports quoted phrases and `-excluded` search terms.
- Tracks exact reuse counts and last-used times.
- Stores each exact prompt variation separately.
- Groups consecutive prompt experiments into expandable variation groups.
- Uses ordered, content-weighted comparison to separate substantial rewrites and marks them as a new direction.
- Allows a grouped variation to be removed from its group without deleting it.
- Copies either the complete positive prompt or a clean selection from the change preview.
- Displays prompt count, last-save time, and backup health in History.
- Exports the complete library and imports it with additive, duplicate-safe merging.

## Storage

History is stored at:

```text
ComfyUI-Simple-Prompt/data/prompt_history.json
```

Writes are atomic and maintain a recovery copy at:

```text
ComfyUI-Simple-Prompt/data/prompt_history.json.bak
```

The database belongs to this standalone package. It does not continuously import from PG-Nodes or expose a configurable history path, avoiding split databases and stale path settings.

## Installation

Place this repository in ComfyUI's `custom_nodes` directory:

```text
ComfyUI/custom_nodes/ComfyUI-Simple-Prompt
```

Restart ComfyUI, then add **Simple Prompt (Standalone)** from the **Simple Prompt** category.

## Origin

The original node and History interface were derived from PG-Nodes. The standalone project exists because the prompt-only workflow evolved into a distinct single-node tool focused on reliable prompt history and reuse.

## License

MIT
