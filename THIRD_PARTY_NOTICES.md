# Third-party components and assets

This project keeps third-party works under their original terms. Its own `UNLICENSED` declaration does not replace the licenses below.

## MCP Memory and TypeScript SDK

- Project: https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- Installed memory package: `@modelcontextprotocol/server-memory` **2.0.1**.
- Upstream inspected commit: `194cc86e3ae6400958555bd4116849d822d69263`.
- Transitive SDK resolved in the lockfile: `@modelcontextprotocol/server` **2.4.0**, https://github.com/modelcontextprotocol/typescript-sdk .
- Original components are consumed through npm, not rewritten or presented as original code. The package's exported `KnowledgeGraphManager` is wrapped for a local companion; MCP server startup is not used.
- The project is transitioning between MIT and Apache-2.0. Its supplied notice and full applicable license texts are retained in `third_party/MCP-MEMORY-LICENSE.txt` and `third_party/modelcontextprotocol-server-LICENSE`.
- This project's new wrapper adds bounded chat episodes, user-evidence checks for extracted facts, pinned user facts, slot corrections, retrieval ranking, cancellation and forget behavior.

## Orama

- Project: https://github.com/oramasearch/orama
- Package: `@orama/orama` **3.1.18**; Apache-2.0.
- Original copyright notice: `third_party/ORAMA-LICENSE.md`; Apache-2.0 license text is also retained with the MCP license files above.
- No Orama engine source is modified. The companion wrapper expands Chinese single/bigram terms before indexing and combines lexical/BM25 relevance with recency and importance. No embedding model, semantic-vector service or Mem0 service is bundled.

## Whale-tail maid frame assets

- Converter/manifest source: https://github.com/QCYTSN/dsh-dafeiyu/tree/084323845ab82b68d5388d5c638bec09d8544a8a/assets
- Original animation source: https://github.com/PC2005-cloud/dsh-pet/tree/549fff2ea33c2acfb16612c76912c6137da4a758/dsh-pet/assets/webm
- Copyright (c) 2026 PC2005-cloud. The upstream MIT text is preserved in `third_party/WHALE-ANIMATION-MIT.txt` and beside the bundled frames.
- The current 16-clip manifest and 3,444 transparent WebP frames are copied without re-encoding or redrawing. The manifest retains video SHA-256, frame ranges, 24fps source and common crop details.
- The source asset notice is copied to `third_party/ANIMATION-ASSET-NOTICE.md`. **No archived/restricted legacy BigFish assets, cursors or sounds are included.**
- This project supplies its own bounded-cache AppKit frame player, native event mappings and interaction logic. It does not claim to have generated the upstream animation set.

## Zod

Zod **4.6.7** is an indirect dependency of the memory components. It is MIT licensed; `third_party/zod-LICENSE` retains the copyright and license.

## Roleplay food and relationship rules — partial MIT reuse in 0.3.0-beta.1

- Project: https://github.com/ajuwm/dsh-roleplay-plugin
- Fixed commit: `c2f4844e8e342c9a0079b7d4df419adb774bccef`.
- Copyright (c) 2026 roleplay-plugin contributors. The complete original MIT license is retained in `third_party/ROLEPLAY-GROWTH-LICENSE.txt`.
- Food values originate from [`roleplay-host.mjs`, lines 178–185](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L178-L185); restoration originates from [`applyItemEffects`, lines 1337–1349](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/roleplay-host.mjs#L1337-L1349).
- The unchanged pure `axisTier` and `repeatDimOf` helpers originate from [`relation-core.mjs`](https://github.com/ajuwm/dsh-roleplay-plugin/blob/c2f4844e8e342c9a0079b7d4df419adb774bccef/agent-presets/roleplay/lib/relation-core.mjs). They are actually called for familiarity stages and diminishing repeated-interaction rewards.
- Local file `third_party/roleplay-game-core.mjs` extracts the four food records and adapts restoration into an immutable `applyFood` wrapper. It is **not** a copy of upstream's similarly named minigame module. This companion calls the satiety/mood rules; the upstream price/health data does not become a purchasing or health system here.
- This project implements its own token receipts and deduplication, snack inventory/reserve, XP thresholds, virtual-state variation, automatic-eating gates, persistence and macOS presentation.
- The full upstream plugin, roleplay presets, character-card management, multi-character relationship data, diaries, anniversaries, minigames, coin purchases, mortality/absence penalties, global Host hooks, PowerShell scripts and Windows pet executables are **not** integrated.

## Researched only — not dependencies or copied implementations

Open-LLM-VTuber remains a research reference. No code, Live2D assets, microphone conversation pipeline or voice-interruption implementation from that project is bundled.

`xp-level-system` and `xp-parser` were inspected as possible XP libraries but are not installed, imported or bundled. Their licenses are not presented as licenses for this project's own XP rules. Research does not imply an integrated feature.

## Reference stills

The still `idle.png` and `shy.png` assets were prepared using an image-generation/editing tool from references supplied for this companion. They are separate from the licensed upstream frame sequence and carry no additional redistribution grant here. No local photo-library filenames, credentials, chat history or captured screen data are distributed.
