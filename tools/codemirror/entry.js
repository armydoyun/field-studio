// js/codemirror.js에 들어갈 CodeMirror 6 API 목록. 편집기 어댑터(js/cm-editor.js)가 쓰는 이름만 내보낸다.
export {EditorState, EditorSelection, Compartment, StateEffect, StateField, Annotation, Transaction, Prec, RangeSetBuilder} from "@codemirror/state";
export {EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  highlightSpecialChars, hoverTooltip, Decoration, ViewPlugin, WidgetType} from "@codemirror/view";
export {defaultKeymap, indentWithTab, toggleComment, toggleBlockComment, indentMore, indentLess, selectLine, deleteLine, cursorMatchingBracket} from "@codemirror/commands";
export {StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, indentUnit, foldGutter, foldKeymap, foldService, codeFolding} from "@codemirror/language";
export {search, searchKeymap, openSearchPanel, closeSearchPanel, highlightSelectionMatches, gotoLine, selectNextOccurrence, selectSelectionMatches} from "@codemirror/search";
export {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, closeCompletion, snippet} from "@codemirror/autocomplete";
export {setDiagnostics, lintGutter, lintKeymap} from "@codemirror/lint";
export {Tag, tags} from "@lezer/highlight";
