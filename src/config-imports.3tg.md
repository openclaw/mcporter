# Exported functions from "src/config-imports.ts"

<!--
```json configuration
{
  "testing-framework": "vitest",
  "no-mock-imports": true
}
```
-->

```json configuration
{
  "before-imports": [
    "// Here we test only `toFileUrl` from `src/config-imports.ts` as",
    "// `pathsForImport` and `readExternalEntries` should be tested for",
    "// their corresponding source code files"
  ]
}
```

## toFileUrl(filePath: string)

These are the functional requirements for function `toFileUrl`.

| test name | filePath        | toFileUrl                       |
| --------- | --------------- | ------------------------------- |
|           | '/foo'          | 'file:///foo' as any            |
|           | '/foo#1'        | 'file:///foo%231' as any        |
|           | '/some/path%.c' | 'file:///some/path%25.c' as any |

We need to use `as any` as the return is of type `URL`, but we'll change the argument for `expect()` so we can compare it with our strings.

```json configuration
{
  "expect-values": {
    "/toFileUrl/": "$$(filePath).href"
  }
}
```
