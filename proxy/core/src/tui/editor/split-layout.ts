import { Selection, Buffer } from "./buffer.ts";

export interface SplitPane {
  id: string;
  viewId: string;
  cursors: Selection[];
  scrollTop: number;
  width?: number;
}

export class SplitLayout {
  panes: SplitPane[] = [];
  activePane: number = 0;
  splitDirection: "vertical" | "horizontal" = "vertical";

  constructor(initialPaneId: string, initialViewId: string, initialCursors: Selection[]) {
    this.panes.push({
      id: initialPaneId,
      viewId: initialViewId,
      cursors: initialCursors,
      scrollTop: 0
    });
  }

  split(direction: "vertical" | "horizontal", newPaneId: string): boolean {
    if (this.panes.length >= 2) return false;
    this.splitDirection = direction;
    const current = this.panes[this.activePane]!;
    this.panes.push({
      id: newPaneId,
      viewId: current.viewId,
      cursors: current.cursors.map(s => ({ anchor: { ...s.anchor }, head: { ...s.head } })),
      scrollTop: current.scrollTop
    });
    this.activePane = 1;
    return true;
  }

  focusPane(index: number): void {
    this.activePane = Math.max(0, Math.min(index, this.panes.length - 1));
  }

  only(): void {
    const pane = this.panes[this.activePane];
    this.panes = pane ? [pane] : [];
    this.activePane = 0;
  }
}
