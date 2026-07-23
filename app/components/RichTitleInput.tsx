"use client";

import { useEffect, useRef, useState } from "react";

const TITLE_COLORS = [
  { label: "기본", value: "#111111" },
  { label: "빨강", value: "#ef4444" },
  { label: "파랑", value: "#2563eb" },
  { label: "초록", value: "#16a34a" },
  { label: "보라", value: "#7c3aed" },
  { label: "주황", value: "#f97316" },
  { label: "회색", value: "#6b7280" },
];

const titleText = (html: string) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim();

export default function RichTitleInput({
  name = "title",
  value,
  onChange,
  placeholder = "제목을 입력해 주세요.",
  autoFocus = false,
  ariaLabel = "게시글 제목",
}: {
  name?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const [empty, setEmpty] = useState(() => titleText(value).length === 0);

  const rememberSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) selectionRef.current = range.cloneRange();
  };

  const sync = () => {
    const html = editorRef.current?.innerHTML ?? "";
    setEmpty(titleText(html).length === 0);
    onChange(html);
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor || editor.innerHTML === value) return;
    editor.innerHTML = value || "";
    setEmpty(titleText(value).length === 0);
  }, [value]);

  const applyColor = (color: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    if (selectionRef.current) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(selectionRef.current);
    }
    document.execCommand("foreColor", false, color);
    rememberSelection();
    sync();
  };

  return <div className="rich-title-input">
    <input type="hidden" name={name} value={value} />
    <div
      ref={editorRef}
      className="rich-title-editable forum-title-input"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="false"
      data-placeholder={placeholder}
      data-empty={empty ? "true" : "false"}
      tabIndex={0}
      autoFocus={autoFocus}
      onInput={sync}
      onBlur={() => { rememberSelection(); sync(); }}
      onKeyUp={rememberSelection}
      onMouseUp={rememberSelection}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
      onPaste={() => setTimeout(sync, 0)}
    />
    <div className="rich-title-toolbar" role="group" aria-label="제목 글자 색상">
      <span>제목 글자색</span>
      {TITLE_COLORS.map((color) => <button
        type="button"
        key={color.value}
        onMouseDown={(event) => {
          rememberSelection();
          event.preventDefault();
        }}
        onClick={() => applyColor(color.value)}
        aria-label={`선택한 제목 글자를 ${color.label} 색상으로 변경`}
        title={`${color.label} 색상`}
      >
        <i style={{ background: color.value }} />
        {color.label}
      </button>)}
      <label>
        <i aria-hidden="true" />
        직접
        <input
          type="color"
          aria-label="제목 글자색 직접 선택"
          defaultValue="#111111"
          onMouseDown={rememberSelection}
          onFocus={rememberSelection}
          onChange={(event) => applyColor(event.target.value)}
        />
      </label>
    </div>
  </div>;
}
