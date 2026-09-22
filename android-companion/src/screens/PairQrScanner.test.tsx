import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PairQrScanner } from "./PairQrScanner";

// The camera's native view is a host stub: these tests assert the
// scanner's own decisions — when it prompts, what it delivers, when it
// gives up — never that a camera exists. Pointing one at a real code is
// device acceptance.
interface MockCameraProps { onBarcodeScanned?: (event: { data: string; type: string }) => void }
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
let mockCamera: MockCameraProps | null = null;
const mockRequestPermission = jest.fn<() => Promise<unknown>>();

jest.mock("expo-camera", () => ({
  CameraView: (props: { onBarcodeScanned?: (event: { data: string; type: string }) => void }) => {
    mockCamera = props;
    return null;
  },
  useCameraPermissions: () => [mockPermission, mockRequestPermission],
}));

const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); });
beforeEach(() => { mockPermission = null; mockCamera = null; mockRequestPermission.mockReset(); });

function render() {
  const onScan = jest.fn<(text: string) => void>();
  const onCancel = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<PairQrScanner onScan={onScan} onCancel={onCancel} />); });
  trees.push(tree);
  return {
    tree,
    onScan,
    onCancel,
    cancel: () => tree.root.findByProps({ accessibilityLabel: "Cancel scanning" }),
    text: () => JSON.stringify(tree.toJSON()),
  };
}

describe("PairQrScanner decisions", () => {
  it("waits for the permission answer before mounting any camera", () => {
    mockPermission = null;
    const screen = render();
    expect(screen.text()).toContain("Preparing the camera");
    expect(mockCamera).toBeNull();
    expect(screen.cancel()).toBeDefined(); // a way out at every stage
  });

  it("mounts the camera when permission arrives", () => {
    mockPermission = null;
    const screen = render();
    expect(mockCamera).toBeNull();
    act(() => {
      mockPermission = { granted: true, canAskAgain: true };
      screen.tree.update(<PairQrScanner onScan={screen.onScan} onCancel={screen.onCancel} />);
    });
    expect(mockCamera).not.toBeNull();
  });

  it("asks for access once when the prompt can still be shown", () => {
    mockPermission = { granted: false, canAskAgain: true };
    const screen = render();
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(screen.text()).toContain("Scanning needs camera access");
    expect(screen.cancel()).toBeDefined();
    expect(mockCamera).toBeNull();
  });

  it("explains a permanent denial instead of re-prompting, with a way out", () => {
    mockPermission = { granted: false, canAskAgain: false };
    const screen = render();
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(screen.text()).toContain("Camera access is off");
    expect(screen.cancel()).toBeDefined();
    act(() => screen.cancel().props.onPress());
    expect(screen.onCancel).toHaveBeenCalledTimes(1);
  });

  it("delivers a scan exactly once even if the view reports it twice", () => {
    mockPermission = { granted: true, canAskAgain: true };
    const screen = render();
    expect(mockCamera).not.toBeNull();
    const report = mockCamera!.onBarcodeScanned!;
    act(() => {
      report({ data: "muster://pair?address=localhost%3A8810&code=004209", type: "qr" });
      report({ data: "the same code again", type: "qr" });
    });
    expect(screen.onScan).toHaveBeenCalledTimes(1);
    expect(screen.onScan).toHaveBeenCalledWith("muster://pair?address=localhost%3A8810&code=004209");
  });
});
