export function structuredTransformationInput(
  rootKey: "claims" | "decisions" | "revisions" | "verdicts",
  payload: unknown,
): string {
  return [
    `待转换输入如下。禁止复制输入，禁止返回输入中的顶级键；输出 JSON 顶层只能包含 ${rootKey}。`,
    "INPUT_JSON:",
    JSON.stringify(payload),
  ].join("\n");
}
