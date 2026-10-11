import { createContext, type JSX, useContext } from "solid-js"
import { read, write } from "../clipboard"
import type { ClipboardService } from "./clipboard-types.ts"
export type { ClipboardContent, ClipboardService } from "./clipboard-types.ts"
const clipboard = { read, write }
const ClipboardContext = createContext<ClipboardService>(clipboard)

export function ClipboardProvider(props: { value?: ClipboardService; children: JSX.Element }) {
  return <ClipboardContext.Provider value={props.value ?? clipboard}>{props.children}</ClipboardContext.Provider>
}

export function useClipboard() {
  return useContext(ClipboardContext)
}
