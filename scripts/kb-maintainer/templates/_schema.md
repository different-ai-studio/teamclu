# LLM Wiki compiler rules

This file is human-maintained. The kb-maintainer reads it and never writes it.

## Page types

- `policy` — 制度、规则、口径
- `process` — 流程和 SOP
- `role` — 岗位职责，不能是具体个人
- `term` — 术语和定义
- `faq` — 稳定、可复用的问答
- `source-summary` — 无法安全拆入主题页时的原文摘要

Every page needs a one-line `summary:` string (used on `index.md`). Prefer a fact from the source, not the filename.

## Hard rules

1. Facts must come from the provided source locators.
2. Do not create pages for named individuals.
3. Do not write ID numbers, phone numbers, insurance numbers, or payroll.
4. Related is not the same. Do not merge distinct entities.
5. On conflict, record the conflict; do not silently overwrite.
