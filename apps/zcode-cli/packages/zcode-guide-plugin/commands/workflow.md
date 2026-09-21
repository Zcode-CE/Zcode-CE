---
description: Design and launch a dynamic workflow for a task.
argument-hint: "[what the workflow should accomplish]"
skills: dynamic-workflows
---

Use the `dynamic-workflows` skill to design and launch a dynamic workflow for this request:

$ARGUMENTS

Decide the subagent topology before writing any code: how many subagents, which of them
share a context, what result each one returns. Then write the script and call the
`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the
legacy `Workflow` tool, and do not substitute the `Agent` tool.)
