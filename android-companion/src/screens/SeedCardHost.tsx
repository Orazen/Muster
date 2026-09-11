import React, { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

interface EditorPresentation {
  node: ReactNode;
  opening: number;
  onClose: () => void;
  onShown: () => void;
}
interface HostedEditor extends EditorPresentation { owner: symbol; key: number }

// Owners live above FlatList. Only presentation slots subscribe to this store,
// so publishing a render cannot feed another render back into its owner.
class SeedPresentations {
  private cards = new Map<string, { owner: symbol; node: ReactNode }>();
  private editor: HostedEditor | null = null;
  private listeners = new Set<() => void>();
  private sequence = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getEditor = () => this.editor;
  getCard = (id: string) => this.cards.get(id)?.node ?? null;
  publish(id: string, owner: symbol, node: ReactNode, editor: EditorPresentation | null) {
    this.cards.set(id, { owner, node });
    if (editor) {
      const key = this.editor?.owner === owner && this.editor.opening === editor.opening ? this.editor.key : ++this.sequence;
      this.editor = { ...editor, owner, key };
    } else if (this.editor?.owner === owner) this.editor = null;
    for (const listener of this.listeners) listener();
  }
  remove(id: string, owner: symbol) {
    if (this.cards.get(id)?.owner === owner) this.cards.delete(id);
    if (this.editor?.owner === owner) this.editor = null;
    for (const listener of this.listeners) listener();
  }
}
const Context = createContext<SeedPresentations | null>(null);
export const useSeedCardHost = () => useContext(Context);

export function SeedCardHost({ children }: { children: ReactNode }) {
  const [host] = useState(() => new SeedPresentations());
  return <Context.Provider value={host}><SeedViewport host={host}>{children}</SeedViewport></Context.Provider>;
}

function SeedViewport({ host, children }: { host: SeedPresentations; children: ReactNode }) {
  const editor = useSyncExternalStore(host.subscribe, host.getEditor, host.getEditor);
  return <View style={styles.root}>
    <View style={styles.root} testID="seed-editor-background" pointerEvents={editor ? "none" : "auto"}
      accessibilityElementsHidden={!!editor} importantForAccessibility={editor ? "no-hide-descendants" : "auto"}>
      {children}
    </View>
    {editor ? <SeedEditorLayer key={editor.key} presentation={editor} /> : null}
  </View>;
}

function SeedEditorLayer({ presentation }: { presentation: HostedEditor }) {
  const insets = useContext(SafeAreaInsetsContext);
  const latest = useRef(presentation);
  useLayoutEffect(() => { latest.current = presentation; });
  useLayoutEffect(() => {
    latest.current.onShown();
    const back = BackHandler.addEventListener("hardwareBackPress", () => { latest.current.onClose(); return true; });
    return () => back.remove();
  }, []);
  return <View style={[StyleSheet.absoluteFill, { paddingTop: insets?.top ?? 0, paddingBottom: insets?.bottom ?? 0,
    paddingLeft: insets?.left ?? 0, paddingRight: insets?.right ?? 0, backgroundColor: "#0a0a0a" }]}
    testID="seed-editor-overlay" accessibilityViewIsModal>
    {presentation.node}
  </View>;
}

export function SeedCardPublication({ id, card, editor }: { id: string; card: ReactNode; editor: EditorPresentation | null }) {
  const host = useSeedCardHost();
  const owner = useRef(Symbol("seed-card-owner")).current;
  if (!host) throw new Error("Seed card owner requires its chat host");
  useLayoutEffect(() => { host.publish(id, owner, card, editor); });
  useLayoutEffect(() => () => { host.remove(id, owner); }, [host, id, owner]);
  return null;
}

export function SeedCardSlot({ id }: { id: string }) {
  const host = useSeedCardHost();
  if (!host) throw new Error("Seed card slot requires its chat host");
  return <>{useSyncExternalStore(host.subscribe, () => host.getCard(id), () => null)}</>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
