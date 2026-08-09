export function explicitNamedMethods(question: string): readonly string[] {
  const normalized = question.normalize("NFKC");
  const labels: string[] = [];
  for (const pattern of [
    /(?:使用|采用|运用|基于|依据|按照|用)\s*([A-Za-z][A-Za-z0-9.+#-]*(?:[ \t]+[A-Za-z][A-Za-z0-9.+#-]*){0,3})/gu,
    /([A-Za-z][A-Za-z0-9.+#-]*(?:[ \t]+[A-Za-z][A-Za-z0-9.+#-]*){0,3})\s*(?:方法|模型|框架|算法)/gu,
    /(?:使用|采用|运用|基于|依据|按照|用)\s*([\p{Script=Han}]{2,20}?(?:画布|地图|模型|框架|方法|算法|矩阵|法))/gu,
  ]) {
    for (const match of normalized.matchAll(pattern)) {
      const label = normalizeNamedMethod(match[1] ?? "");
      if (label.length >= 3 && !labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

export function normalizeNamedMethod(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Script=Han}a-z0-9+#]+/gu, "");
}
