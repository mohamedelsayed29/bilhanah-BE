import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { useLanguage } from '../lib/language';

type Props = { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string };

export function Dialog({ open, onClose, title, children, className = '' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const { text } = useLanguage();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    dialog.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = oldOverflow; };
  }, [open]);
  return <dialog ref={ref} className={`dialog ${className}`} aria-label={title}
    onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <button className="icon-button dialog-close" onClick={onClose} aria-label={text('إغلاق', 'Close')}><XIcon size={22} /></button>
    {children}
  </dialog>;
}
