import { useEffect } from "react";

export function useKeyboardShortcuts({ onEscape, onSearch, onRefresh, onCommandPalette }) {
  useEffect(() => {
    function handler(e) {
      const tag = (e.target?.tagName || "").toLowerCase();
      const isInput = tag === "input" || tag === "textarea" || tag === "select";

      if (e.key === "Escape") {
        if (isInput) {
          e.target.blur();
        }
        onEscape?.();
        return;
      }

      if (isInput) return;

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onCommandPalette?.();
        return;
      }

      if (e.key === "/" || e.key === "f" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSearch?.();
        return;
      }

      if (e.key === "r" && !e.metaKey && !e.ctrlKey) {
        onRefresh?.();
        return;
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onEscape, onSearch, onRefresh, onCommandPalette]);
}
