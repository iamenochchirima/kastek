"use client"

import * as React from "react"

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type ConfirmOptions = {
  title: string
  description?: string
  confirmLabel?: string
  variant?: "default" | "destructive"
}

type PromptOptions = {
  title: string
  description?: string
  label: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  multiline?: boolean
}

type ConfirmationContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
}

const ConfirmationContext = React.createContext<ConfirmationContextValue | null>(null)

export function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const [confirmOptions, setConfirmOptions] = React.useState<ConfirmOptions | null>(null)
  const [promptOptions, setPromptOptions] = React.useState<PromptOptions | null>(null)
  const [promptValue, setPromptValue] = React.useState("")
  const confirmResolve = React.useRef<((value: boolean) => void) | null>(null)
  const promptResolve = React.useRef<((value: string | null) => void) | null>(null)

  const settleConfirm = React.useCallback((value: boolean) => {
    confirmResolve.current?.(value)
    confirmResolve.current = null
    setConfirmOptions(null)
  }, [])

  const settlePrompt = React.useCallback((value: string | null) => {
    promptResolve.current?.(value)
    promptResolve.current = null
    setPromptOptions(null)
  }, [])

  const value = React.useMemo<ConfirmationContextValue>(() => ({
    confirm: (options) => new Promise<boolean>((resolve) => {
      confirmResolve.current = resolve
      setConfirmOptions(options)
    }),
    prompt: (options) => new Promise<string | null>((resolve) => {
      promptResolve.current = resolve
      setPromptValue(options.defaultValue ?? "")
      setPromptOptions(options)
    }),
  }), [])

  return (
    <ConfirmationContext.Provider value={value}>
      {children}
      <AlertDialog open={confirmOptions !== null} onOpenChange={(open) => { if (!open) settleConfirm(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmOptions?.title}</AlertDialogTitle>
            {confirmOptions?.description ? <AlertDialogDescription>{confirmOptions.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={confirmOptions?.variant === "destructive" ? "bg-destructive text-white hover:bg-destructive/90" : undefined} onClick={() => settleConfirm(true)}>
              {confirmOptions?.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={promptOptions !== null} onOpenChange={(open) => { if (!open) settlePrompt(null) }}>
        <DialogContent showCloseButton={false}>
          <form onSubmit={(event) => { event.preventDefault(); settlePrompt(promptValue) }}>
            <DialogHeader>
              <DialogTitle>{promptOptions?.title}</DialogTitle>
              {promptOptions?.description ? <DialogDescription>{promptOptions.description}</DialogDescription> : null}
            </DialogHeader>
            <label className="mt-5 block space-y-2 text-sm font-medium text-foreground">
              <span>{promptOptions?.label}</span>
              {promptOptions?.multiline ? <textarea autoFocus value={promptValue} onChange={(event) => setPromptValue(event.target.value)} placeholder={promptOptions.placeholder} className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 min-h-28 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]" /> : <Input autoFocus value={promptValue} onChange={(event) => setPromptValue(event.target.value)} placeholder={promptOptions?.placeholder} />}
            </label>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => settlePrompt(null)}>Cancel</Button>
              <Button type="submit">{promptOptions?.confirmLabel ?? "Continue"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ConfirmationContext.Provider>
  )
}

export function useConfirmationDialog() {
  const context = React.useContext(ConfirmationContext)
  if (!context) throw new Error("useConfirmationDialog must be used within ConfirmationProvider")
  return context
}
