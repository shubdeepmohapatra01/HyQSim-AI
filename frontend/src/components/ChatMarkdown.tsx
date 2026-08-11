/**
 * Minimal markdown renderer for assistant messages.
 *
 * Models emit `**bold**`, `##` headings and `-` bullets whether or not you ask them to,
 * and the chat panel used to render those literally. This covers the subset that actually
 * shows up in practice; anything else falls through as plain text. No dependency, because
 * a full markdown library would dwarf the rest of the AI code.
 */

import { Fragment, type ReactNode } from 'react';

/** Splits on `**bold**`, `*italic*`, `` `code` `` and $math$, preserving order. */
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_RE).filter(s => s !== '');
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="font-mono text-[11px] bg-slate-900 text-emerald-300 rounded px-1 py-px">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key} className="italic">{part.slice(1, -1)}</em>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export default function ChatMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={key} className="list-disc pl-4 space-y-0.5 my-1">
        {listBuffer.map((item, i) => <li key={i}>{renderInline(item, `${key}-${i}`)}</li>)}
      </ul>,
    );
    listBuffer = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      listBuffer.push(bullet[1]);
      return;
    }
    flushList(`list-${idx}`);

    if (line.trim() === '') {
      blocks.push(<div key={`sp-${idx}`} className="h-1.5" />);
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={`h-${idx}`} className="font-semibold text-white mt-1.5 first:mt-0">
          {renderInline(heading[2], `h-${idx}`)}
        </p>,
      );
      return;
    }

    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push(
        <p key={`n-${idx}`} className="pl-3 -indent-3">
          <span className="text-slate-400">{numbered[1]}. </span>
          {renderInline(numbered[2], `n-${idx}`)}
        </p>,
      );
      return;
    }

    blocks.push(<p key={`p-${idx}`}>{renderInline(line, `p-${idx}`)}</p>);
  });

  flushList('list-end');
  return <div className="space-y-0.5">{blocks}</div>;
}
