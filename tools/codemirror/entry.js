// js/codemirror.js에 들어갈 CodeMirror 6 API 목록. 편집기 어댑터(js/cm-editor.js)가 쓰는 이름만 내보낸다.
export {EditorState, EditorSelection, Compartment, StateEffect, StateField, Annotation, Transaction, Prec, RangeSetBuilder} from "@codemirror/state";
export {EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  highlightSpecialChars, hoverTooltip, Decoration, ViewPlugin, WidgetType, showTooltip, scrollPastEnd, placeholder, highlightTrailingWhitespace, closeHoverTooltips} from "@codemirror/view";
export {defaultKeymap, indentWithTab, toggleComment, toggleBlockComment, indentMore, indentLess, selectLine, deleteLine, cursorMatchingBracket,
  addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, moveLineDown, moveLineUp, insertBlankLine, selectAll, toggleTabFocusMode} from "@codemirror/commands";
export {StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput, indentUnit, foldGutter, foldKeymap, foldService, codeFolding, foldAll, unfoldAll, foldCode, unfoldCode} from "@codemirror/language";
export {search, searchKeymap, openSearchPanel, closeSearchPanel, highlightSelectionMatches, gotoLine, selectNextOccurrence, selectSelectionMatches} from "@codemirror/search";
export {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion, closeCompletion, snippet} from "@codemirror/autocomplete";
export {setDiagnostics, lintGutter, lintKeymap, nextDiagnostic, previousDiagnostic, openLintPanel, closeLintPanel} from "@codemirror/lint";
export {Tag, tags} from "@lezer/highlight";
