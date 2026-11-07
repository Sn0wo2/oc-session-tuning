export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

export const clip = (value: string, max: number) => {
  const text = value.trim()
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n[… ${omitted} more characters …]`
}
