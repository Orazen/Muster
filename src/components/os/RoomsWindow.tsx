// Rooms window for the OS desktop — the RoomsPanel living inside the
// window system instead of always visible on the desktop body. The panel
// keeps its own zod-validated wiring; this wrapper only supplies window
// chrome. Stays mounted while minimized so the live poll and list state
// survive a dock restore.
import { RoomsPanel } from "@/components/os/RoomsPanel";
import { WindowFrame } from "@/components/os/Window";

interface RoomsWindowProps {
  focused: boolean;
  minimized: boolean;
  zIndex: number;
  cascade: number;
  onFocus: () => void;
  onMinimize: () => void;
  onClose: () => void;
}

export function RoomsWindow({
  focused,
  minimized,
  zIndex,
  cascade,
  onFocus,
  onMinimize,
  onClose,
}: RoomsWindowProps) {
  return (
    <WindowFrame
      title="Rooms"
      ariaLabel="Agent rooms window"
      focused={focused}
      minimized={minimized}
      zIndex={zIndex}
      cascade={cascade}
      width={440}
      height={480}
      onFocus={onFocus}
      onMinimize={onMinimize}
      onClose={onClose}
    >
      <div className="os-window-body os-window-body-rooms">
        <RoomsPanel />
      </div>
    </WindowFrame>
  );
}
