import CodeEditorHeader, {
  FileName,
} from "@/components/package-port/CodeEditorHeader"
import { useCodeCompletionApi } from "@/hooks/use-code-completion-ai-api"
import { useHotkeyCombo } from "@/hooks/use-hotkey"
import { useShikiHighlighter } from "@/hooks/use-shiki-highlighter"
import { useSnippetsBaseApiUrl } from "@/hooks/use-snippets-base-api-url"
import {
  ICreateFileProps,
  ICreateFileResult,
  IDeleteFileProps,
  IDeleteFileResult,
} from "@/hooks/useFileManagement"
import { basicSetup } from "@/lib/codemirror/basic-setup"
import { TSCI_PACKAGE_PATTERN } from "@/lib/constants"
import { loadDefaultLibMap } from "@/lib/ts-lib-cache"
import { findTargetFile } from "@/lib/utils/findTargetFile"
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
} from "@codemirror/autocomplete"
import { indentMore, indentWithTab } from "@codemirror/commands"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { linter } from "@codemirror/lint"
import { EditorState, Prec } from "@codemirror/state"
import { Decoration, hoverTooltip, keymap } from "@codemirror/view"
import { getImportsFromCode } from "@tscircuit/prompt-benchmarks/code-runner-utils"
import type { ATABootstrapConfig } from "@typescript/ata"
import { setupTypeAcquisition } from "@typescript/ata"
import {
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs"
import { tsAutocomplete, tsFacet, tsSync } from "@valtown/codemirror-ts"
import { getLints } from "@valtown/codemirror-ts"
import { EditorView } from "codemirror"
import { useEffect, useMemo, useRef, useState } from "react"
import tsModule from "typescript"
import FileSidebar from "../FileSidebar"
import { isHiddenFile } from "../ViewPackagePage/utils/is-hidden-file"
import type { PackageFile } from "./CodeAndPreview"
import GlobalFindReplace from "./GlobalFindReplace"
import QuickOpen from "./QuickOpen"

const defaultImports = `
import React from "@types/react/jsx-runtime"
import { Circuit, createUseComponent } from "@tscircuit/core"
import type { CommonLayoutProps } from "@tscircuit/props"
`

export const CodeEditor = ({
  onCodeChange,
  readOnly = false,
  files = [],
  isSaving = false,
  isStreaming = false,
  showImportAndFormatButtons = true,
  onFileContentChanged,
  pkgFilesLoaded,
  currentFile,
  onFileSelect,
  handleCreateFile,
  handleDeleteFile,
}: {
  onCodeChange: (code: string, filename?: string) => void
  files: PackageFile[]
  isSaving?: boolean
  handleCreateFile: (props: ICreateFileProps) => ICreateFileResult
  handleDeleteFile: (props: IDeleteFileProps) => IDeleteFileResult
  readOnly?: boolean
  isStreaming?: boolean
  pkgFilesLoaded?: boolean
  showImportAndFormatButtons?: boolean
  onFileContentChanged?: (path: string, content: string) => void
  currentFile: string | null
  onFileSelect: (path: string) => void
}) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const ataRef = useRef<ReturnType<typeof setupTypeAcquisition> | null>(null)
  const lastReceivedTsFileTimeRef = useRef<number>(0)
  const apiUrl = useSnippetsBaseApiUrl()
  const codeCompletionApi = useCodeCompletionApi()
  const [cursorPosition, setCursorPosition] = useState<number | null>(null)
  const [code, setCode] = useState(files[0]?.content || "")
  const [fontSize, setFontSize] = useState(14)
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [showGlobalFindReplace, setShowGlobalFindReplace] = useState(false)

  const { highlighter } = useShikiHighlighter()

  // Get URL search params for file_path
  const urlParams = new URLSearchParams(window.location.search)
  const filePathFromUrl = urlParams.get("file_path")

  const entryPointFileName = useMemo(() => {
    const entryPointFile = findTargetFile(files, null)
    if (entryPointFile?.path) return entryPointFile.path
    return files.find((x) => x.path === "index.tsx")?.path || "index.tsx"
  }, [files])

  // Set current file on component mount
  useEffect(() => {
    if (files.length === 0 || !pkgFilesLoaded || currentFile) return

    const targetFile = findTargetFile(files, filePathFromUrl)
    if (targetFile) {
      handleFileChange(targetFile.path)
      setCode(targetFile.content)
    }
  }, [filePathFromUrl, pkgFilesLoaded])

  const fileMap = useMemo(() => {
    const map: Record<string, string> = {}
    files.forEach((file) => {
      map[file.path] = file.content
    })
    return map
  }, [files])

  useEffect(() => {
    const currentFileContent =
      files.find((f) => f.path === currentFile)?.content || ""
    if (currentFileContent !== code) {
      setCode(currentFileContent)
      updateCurrentEditorContent(currentFileContent)
    }
  }, [files])

  // Whenever streaming completes, reset the code to the initial code
  useEffect(() => {
    if (!isStreaming) {
      const currentFileContent =
        files.find((f) => f.path === currentFile)?.content || ""
      if (code !== currentFileContent && currentFileContent) {
        setCode(currentFileContent)
        setTimeout(() => {
          updateCurrentEditorContent(currentFileContent)
        }, 200)
      }
    }
  }, [isStreaming])

  useHotkeyCombo(
    "cmd+b",
    () => {
      setSidebarOpen((prev) => !prev)
    },
    { target: window },
  )

  useEffect(() => {
    if (!editorRef.current) return

    const fsMap = new Map<string, string>()
    files.forEach(({ path, content }) => {
      fsMap.set(`${path.startsWith("/") ? "" : "/"}${path}`, content)
    })
    ;(window as any).__DEBUG_CODE_EDITOR_FS_MAP = fsMap

    loadDefaultLibMap().then((defaultFsMap) => {
      defaultFsMap.forEach((content, filename) => {
        fsMap.set(filename, content)
      })
    })

    const system = createSystem(fsMap)

    const env = createVirtualTypeScriptEnvironment(system, [], tsModule, {
      jsx: tsModule.JsxEmit.ReactJSX,
      declaration: true,
      allowJs: true,
      target: tsModule.ScriptTarget.ES2022,
      resolveJsonModule: true,
    })

    // Add alias for tscircuit -> @tscircuit/core
    const tscircuitAliasDeclaration = `declare module "tscircuit" { export * from "@tscircuit/core"; }`
    env.createFile("tscircuit-alias.d.ts", tscircuitAliasDeclaration)

    // Initialize ATA
    const ataConfig: ATABootstrapConfig = {
      projectName: "my-project",
      typescript: tsModule,
      logger: console,
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const registryPrefixes = [
          "https://data.jsdelivr.com/v1/package/resolve/npm/@tsci/",
          "https://data.jsdelivr.com/v1/package/npm/@tsci/",
          "https://cdn.jsdelivr.net/npm/@tsci/",
        ]
        if (
          typeof input === "string" &&
          registryPrefixes.some((prefix) => input.startsWith(prefix))
        ) {
          const fullPackageName = input
            .replace(registryPrefixes[0], "")
            .replace(registryPrefixes[1], "")
            .replace(registryPrefixes[2], "")
          const packageName = fullPackageName.split("/")[0].replace(/\./, "/")
          const pathInPackage = fullPackageName.split("/").slice(1).join("/")
          const jsdelivrPath = `${packageName}${
            pathInPackage ? `/${pathInPackage}` : ""
          }`
          return fetch(
            `${apiUrl}/snippets/download?jsdelivr_resolve=${input.includes(
              "/resolve/",
            )}&jsdelivr_path=${encodeURIComponent(jsdelivrPath)}`,
          )
        }
        return fetch(input, init)
      },
      delegate: {
        started: () => {
          const manualEditsTypeDeclaration = `
				  declare module "manual-edits.json" {
				  const value: {
					  pcb_placements?: any[],
            schematic_placements?: any[],
					  edit_events?: any[],
					  manual_trace_hints?: any[],
				  } | undefined;
				  export default value;
				}
			`
          env.createFile("manual-edits.d.ts", manualEditsTypeDeclaration)
        },
        receivedFile: (code: string, path: string) => {
          fsMap.set(path, code)
          env.createFile(path, code)
          if (/\.tsx?$|\.d\.ts$/.test(path)) {
            lastReceivedTsFileTimeRef.current = Date.now()
          }
          // Avoid dispatching a view update when ATA downloads files. Dispatching
          // here caused the editor to reset the user's selection, which made text
          // selection impossible while dependencies were loading.
        },
      },
    }

    const ata = setupTypeAcquisition(ataConfig)
    ataRef.current = ata

    const lastFilesEventContent: Record<string, string> = {}

    // Set up base extensions
    const baseExtensions = [
      basicSetup,
      currentFile?.endsWith(".json")
        ? json()
        : javascript({ typescript: true, jsx: true }),
      Prec.high(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => true,
          },
          {
            key: "Tab",
            run: (view) => {
              if (completionStatus(view.state) === "active") {
                return acceptCompletion(view)
              }
              return indentMore(view)
            },
          },
          {
            key: "Mod-p",
            run: () => {
              setShowQuickOpen(true)
              return true
            },
          },
          {
            key: "Mod-Shift-f",
            run: () => {
              setShowGlobalFindReplace(true)
              return true
            },
          },
        ]),
      ),
      keymap.of([indentWithTab]),
      EditorState.readOnly.of(readOnly || isSaving),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString()
          if (!currentFile) return
          if (newContent === lastFilesEventContent[currentFile]) return
          lastFilesEventContent[currentFile] = newContent

          // setCode(newContent)
          onCodeChange(newContent, currentFile)
          onFileContentChanged?.(currentFile, newContent)
        }
        if (update.selectionSet) {
          const pos = update.state.selection.main.head
          setCursorPosition(pos)
        }
      }),
      EditorView.theme({
        ".cm-editor": {
          fontSize: `${fontSize}px`,
        },
        ".cm-content": {
          fontSize: `${fontSize}px`,
        },
      }),
      EditorView.domEventHandlers({
        wheel: (event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            const delta = event.deltaY
            setFontSize((prev) => {
              const newSize =
                delta > 0 ? Math.max(8, prev - 1) : Math.min(32, prev + 1)
              return newSize
            })
            return true
          }
          return false
        },
      }),
    ]
    if (codeCompletionApi?.apiKey) {
      baseExtensions.push(
        // copilotPlugin({
        //   apiKey: codeCompletionApi.apiKey,
        //   language: Language.TYPESCRIPT,
        // }),
        EditorView.theme({
          ".cm-ghostText, .cm-ghostText *": {
            opacity: "0.6",
            filter: "grayscale(20%)",
            cursor: "pointer",
          },
          ".cm-ghostText:hover": {
            background: "#eee",
          },
        }),
      )
    }

    // Add TypeScript-specific extensions and handlers
    const tsExtensions =
      currentFile?.endsWith(".tsx") || currentFile?.endsWith(".ts")
        ? [
            tsFacet.of({
              env,
              path: currentFile?.endsWith(".ts")
                ? currentFile?.replace(/\.ts$/, ".tsx")
                : currentFile,
            }),
            tsSync(),
            linter(async (view) => {
              if (Date.now() - lastReceivedTsFileTimeRef.current < 3000) {
                return []
              }
              const config = view.state.facet(tsFacet)
              return config
                ? getLints({
                    ...config,
                    diagnosticCodesToIgnore: [],
                  })
                : []
            }),
            autocompletion({ override: [tsAutocomplete()] }),
            hoverTooltip((view, pos) => {
              const line = view.state.doc.lineAt(pos)
              const lineStart = line.from
              const lineEnd = line.to
              const lineText = view.state.sliceDoc(lineStart, lineEnd)
              const matches = Array.from(
                lineText.matchAll(TSCI_PACKAGE_PATTERN),
              )

              for (const match of matches) {
                if (match.index !== undefined) {
                  const start = lineStart + match.index
                  const end = start + match[0].length
                  if (pos >= start && pos <= end) {
                    return {
                      pos: start,
                      end: end,
                      above: true,
                      create() {
                        const dom = document.createElement("div")
                        dom.textContent = "Ctrl/Cmd+Click to open package"
                        return { dom }
                      },
                    }
                  }
                }
              }
              const facet = view.state.facet(tsFacet)
              if (!facet) return null

              const { env, path } = facet
              const info = env.languageService.getQuickInfoAtPosition(path, pos)
              if (!info) return null

              const start = info.textSpan.start
              const end = start + info.textSpan.length
              const content = tsModule?.displayPartsToString(
                info.displayParts || [],
              )

              const dom = document.createElement("div")
              if (highlighter) {
                dom.innerHTML = highlighter.codeToHtml(content, {
                  lang: "tsx",
                  themes: {
                    light: "github-light",
                    dark: "github-dark",
                  },
                })

                return {
                  pos: start,
                  end,
                  above: true,
                  create: () => ({ dom }),
                }
              }
              return null
            }),
            EditorView.domEventHandlers({
              click: (event, view) => {
                if (!event.ctrlKey && !event.metaKey) return false
                const pos = view.posAtCoords({
                  x: event.clientX,
                  y: event.clientY,
                })
                if (pos === null) return false

                const line = view.state.doc.lineAt(pos)
                const lineStart = line.from
                const lineEnd = line.to
                const lineText = view.state.sliceDoc(lineStart, lineEnd)
                const matches = Array.from(
                  lineText.matchAll(TSCI_PACKAGE_PATTERN),
                )
                for (const match of matches) {
                  if (match.index !== undefined) {
                    const start = lineStart + match.index
                    const end = start + match[0].length
                    if (pos >= start && pos <= end) {
                      const importName = match[0]
                      // Handle potential dots and dashes in package names
                      const [owner, name] = importName
                        .replace("@tsci/", "")
                        .split(".")
                      window.open(`/${owner}/${name}`, "_blank")
                      return true
                    }
                  }
                }
                return false
              },
              keydown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault()
                  return true
                }
                return false
              },
            }),
            EditorView.theme({
              ".cm-tooltip-hover": {
                maxWidth: "600px",
                padding: "12px",
                maxHeight: "400px",
                borderRadius: "0.5rem",
                backgroundColor: "#fff",
                color: "#0f172a",
                border: "1px solid #e2e8f0",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
                fontSize: "14px",
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                lineHeight: "1.6",
                overflow: "auto",
                zIndex: "9999",
              },
            }),
            EditorView.decorations.of((view) => {
              const decorations = []
              for (const { from, to } of view.visibleRanges) {
                for (let pos = from; pos < to; ) {
                  const line = view.state.doc.lineAt(pos)
                  const lineText = line.text
                  const matches = lineText.matchAll(TSCI_PACKAGE_PATTERN)
                  for (const match of matches) {
                    if (match.index !== undefined) {
                      const start = line.from + match.index
                      const end = start + match[0].length
                      decorations.push(
                        Decoration.mark({
                          class: "cm-underline cursor-pointer",
                        }).range(start, end),
                      )
                    }
                  }
                  pos = line.to + 1
                }
              }
              return Decoration.set(decorations)
            }),
          ]
        : []

    const state = EditorState.create({
      doc: fileMap[currentFile || ""] || "",
      extensions: [...baseExtensions, ...tsExtensions],
    })

    const view = new EditorView({
      state,
      parent: editorRef.current,
    })

    viewRef.current = view

    if (currentFile?.endsWith(".tsx") || currentFile?.endsWith(".ts")) {
      ata(`${defaultImports}${code}`)
    }

    return () => {
      view.destroy()
    }
  }, [
    !isStreaming,
    currentFile,
    code !== "",
    Boolean(highlighter),
    isSaving,
    fontSize,
  ])

  const updateCurrentEditorContent = (newContent: string) => {
    if (viewRef.current) {
      const state = viewRef.current.state
      const scrollPos = viewRef.current.scrollDOM.scrollTop
      if (state.doc.toString() !== newContent) {
        viewRef.current.dispatch({
          changes: { from: 0, to: state.doc.length, insert: newContent },
        })
        requestAnimationFrame(() => {
          if (viewRef.current) {
            viewRef.current.scrollDOM.scrollTop = scrollPos
          }
        })
      }
    }
  }

  const updateEditorToMatchCurrentFile = () => {
    const currentContent = fileMap[currentFile || ""] || ""
    updateCurrentEditorContent(currentContent)
  }

  const codeImports = getImportsFromCode(code)

  useEffect(() => {
    if (
      ataRef.current &&
      (currentFile?.endsWith(".tsx") || currentFile?.endsWith(".ts"))
    ) {
      ataRef.current(`${defaultImports}${code}`)
    }
  }, [codeImports])

  const handleFileChange = (path: string) => {
    onFileSelect(path)
    try {
      // Set url query to file path
      const urlParams = new URLSearchParams(window.location.search)
      urlParams.set("file_path", path)
      window.history.replaceState(null, "", `?${urlParams.toString()}`)
    } catch {}
  }

  const updateFileContent = (path: FileName | null, newContent: string) => {
    if (!path) return
    if (currentFile === path) {
      setCode(newContent)
      onCodeChange(newContent, path)
    } else {
      fileMap[path] = newContent
    }
    onFileContentChanged?.(path, newContent)

    if (viewRef.current && currentFile === path) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: newContent,
        },
      })
    }
  }

  // Whenever the current file changes, updated the editor content
  useEffect(() => {
    updateEditorToMatchCurrentFile()
  }, [currentFile])

  // Global keyboard listeners
  useHotkeyCombo("cmd+p", () => {
    setShowQuickOpen(true)
  })

  useHotkeyCombo("cmd+shift+f", () => {
    setShowGlobalFindReplace(true)
  })

  useHotkeyCombo("Escape", () => {
    if (showQuickOpen) {
      setShowQuickOpen(false)
    }
    if (showGlobalFindReplace) {
      setShowGlobalFindReplace(false)
    }
  })

  if (isStreaming) {
    return <div className="font-mono whitespace-pre-wrap text-xs">{code}</div>
  }
  const [sidebarOpen, setSidebarOpen] = useState(false)
  return (
    <div className="flex h-[98vh] w-full overflow-hidden">
      <FileSidebar
        files={Object.fromEntries(files.map((f) => [f.path, f.content]))}
        currentFile={currentFile}
        fileSidebarState={
          [sidebarOpen, setSidebarOpen] as ReturnType<typeof useState<boolean>>
        }
        onFileSelect={handleFileChange}
        handleCreateFile={handleCreateFile}
        handleDeleteFile={handleDeleteFile}
      />
      <div className="flex flex-col flex-1 w-full min-w-0 h-full">
        {showImportAndFormatButtons && (
          <CodeEditorHeader
            entrypointFileName={entryPointFileName}
            fileSidebarState={
              [sidebarOpen, setSidebarOpen] as ReturnType<
                typeof useState<boolean>
              >
            }
            currentFile={currentFile}
            files={Object.fromEntries(files.map((f) => [f.path, f.content]))}
            updateFileContent={updateFileContent}
            handleFileChange={handleFileChange}
          />
        )}
        <div
          ref={editorRef}
          className={
            "flex-1 overflow-auto [&_.cm-editor]:h-full [&_.cm-scroller]:!h-full"
          }
        />
      </div>
      {showQuickOpen && (
        <QuickOpen
          files={files.filter((f) => !isHiddenFile(f.path))}
          currentFile={currentFile}
          onFileSelect={handleFileChange}
          onClose={() => setShowQuickOpen(false)}
        />
      )}
      {showGlobalFindReplace && (
        <GlobalFindReplace
          files={files.filter((f) => !isHiddenFile(f.path))}
          currentFile={currentFile}
          onFileSelect={handleFileChange}
          onFileContentChanged={onCodeChange}
          onClose={() => setShowGlobalFindReplace(false)}
        />
      )}
    </div>
  )
}
