"use client";

import { useEffect } from "react";

export function LicensingModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-w-md flex-col gap-4 border border-gray-700 bg-black p-8"
      >
        <h3 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Licensing
        </h3>
        <p className="text-gray-100">
          Cited makes PR tech stacks smarter. To start a conversation
          about licensing it, email newbiz at breadandlaw dot com.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="self-start text-sm uppercase tracking-[0.2em] text-gray-600 hover:text-gray-100"
        >
          Close
        </button>
      </div>
    </div>
  );
}
