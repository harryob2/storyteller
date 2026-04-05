export const tabs = [
  "library",
  "transcription",
  "auth",
  "upload",
  "email",
  "opds",
] as const

export type Tab = (typeof tabs)[number]

export type SectionKeywords = {
  [K in Tab]: {
    [S: string]: string[]
  }
}
