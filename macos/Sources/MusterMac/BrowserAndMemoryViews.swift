// Browser and Memory surfaces from the concept, fixture-local.
//
// The browser panel draws a local sample page — the M0 boundary forbids a
// live WKWebView, network navigation or any real session. What M0 proves is
// the STATE MODEL the real adapter must reproduce: agent-controlled vs.
// human takeover, with the visible control always naming who acts.

import MusterMacCore
import SwiftUI

struct BrowserPanelView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "globe")
                Text("Launch brief").font(.caption.weight(.medium))
                Text("· Sample page").font(.caption2).foregroundStyle(.tertiary)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(.quinary.opacity(0.5))
            Divider()
            HStack {
                Image(systemName: "arrow.clockwise")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("notes.muster.test / launch-brief")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(.quinary, in: RoundedRectangle(cornerRadius: 5))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Label("Muster workspace", systemImage: "circle.hexagongrid.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("A LITTLE HELP.\nA LOT MORE POSSIBILITY.".lowercased())
                        .font(.system(size: 24, weight: .medium))
                        .kerning(-0.8)
                    Text("A home for the launch ideas, thoughtful details, and small steps that make a big difference.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    FlowerView(colorName: nil, busy: false)
                        .frame(width: 72, height: 72)
                        .rotationEffect(.degrees(-8))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 18)
                        .background(.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    row("01", "Make the first minute feel effortless")
                    row("02", "Show one useful, complete task")
                    row("03", "Invite a small group to try it")
                }
                .padding(24)
            }
            Divider()
            HStack {
                Label(
                    model.browserControl == .humanTakeover ? "You're in control · Preview" : "Muster's browser · Preview",
                    systemImage: model.browserControl == .humanTakeover ? "laptopcomputer" : "globe"
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
                Spacer()
                Button(model.browserControl == .humanTakeover ? "Resume preview" : "Take control") {
                    model.browserControl = model.browserControl == .humanTakeover ? .agent : .humanTakeover
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .accessibilityIdentifier("takeover-toggle")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.quinary.opacity(0.5))
        }
    }

    private func row(_ index: String, _ text: String) -> some View {
        HStack(spacing: 10) {
            Text(index).font(.caption2).foregroundStyle(.tertiary)
            Text(text).font(.caption)
            Spacer()
            Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 10)
        .overlay(Divider(), alignment: .top)
    }
}

struct MemoryView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("YOUR PERSONAL ASSISTANT").font(.caption2).foregroundStyle(.secondary)
                    Text("A little understanding.").font(.largeTitle.weight(.medium)).kerning(-1)
                    Text("The things you choose to let Muster remember. Always yours to review.")
                        .font(.callout).foregroundStyle(.secondary)
                    HStack {
                        Text("SAMPLE MEMORIES").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        Spacer()
                        Button("Reset examples") { model.resetMemories() }
                            .buttonStyle(.link)
                            .font(.caption)
                            .accessibilityIdentifier("memory-reset")
                    }
                    if model.memories.isEmpty {
                        Text("No sample memories. You can reset the examples above.")
                            .font(.callout).foregroundStyle(.secondary)
                            .padding(.vertical, 18)
                    }
                    ForEach(model.memories) { memory in
                        HStack(spacing: 12) {
                            Image(systemName: "memorychip")
                                .frame(width: 24, height: 24)
                                .background(.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(memory.text).font(.callout)
                                Text(memory.origin).font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Forget") { model.forgetMemory(id: memory.id) }
                                .buttonStyle(.link)
                                .font(.caption)
                                .accessibilityIdentifier("forget-\(memory.id)")
                        }
                        .padding(.vertical, 10)
                        .overlay(Divider(), alignment: .bottom)
                    }
                    HStack(alignment: .top, spacing: 10) {
                        FlowerView(colorName: nil, busy: false)
                            .frame(width: 22, height: 22)
                            .rotationEffect(.degrees(-5))
                        Text("Personalization should feel helpful.\nYou decide what stays.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(24)
            }
            if model.contextPanelVisible {
                Divider()
                VStack {
                    Text("Memory keeps to this window")
                        .font(.caption.weight(.medium))
                    Text("Nothing here reads or writes a real preference store. Reset restores the fixture examples.")
                        .font(.caption2).foregroundStyle(.secondary)
                        .padding(.top, 4)
                    Spacer()
                }
                .padding(20)
                .frame(width: 284, alignment: .leading)
                .background(.quinary.opacity(0.4))
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("MAKE YOURSELF AT HOME").font(.caption2).foregroundStyle(.secondary)
                Text("A little more you.").font(.largeTitle.weight(.medium)).kerning(-1)
                Text("Simple choices, with the details there when you need them.")
                    .font(.callout).foregroundStyle(.secondary)

                group("APPEARANCE") {
                    settingRow(title: "Theme",
                               detail: "Keep it light, go dark, or follow your Mac.") {
                        Picker("Theme", selection: $model.appearance) {
                            ForEach(Appearance.allCases, id: \.self) { appearance in
                                Text(appearance.rawValue.capitalized).tag(appearance)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 130)
                        .accessibilityIdentifier("theme-picker")
                    }
                }

                group("YOUR AI") {
                    settingRow(title: "Model",
                               detail: "One recommendation for your device. Downloads need your explicit approval and show their size.",
                               control: { pill("Concept") })
                    settingRow(title: "Cloud assistance",
                               detail: "Ask for each task. Show what will be shared, and with which provider.",
                               control: { pill("Ask first") })
                }

                group("CONNECTIONS & RECOVERY") {
                    settingRow(title: "Google account",
                               detail: "Account and app access are separate choices.",
                               control: { previewButton("Preview setup") })
                    settingRow(title: "Google Drive",
                               detail: "Not connected in this prototype. Backup is not sync.",
                               control: { previewButton("Preview setup") })
                    settingRow(title: "Your devices",
                               detail: "Choose where work is allowed to run.",
                               control: { previewButton("Manage") })
                }
            }
            .padding(24)
        }
    }

    private func group(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 0) { content() }
                .background(.background, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
        }
    }

    private func settingRow<Control: View>(title: String, detail: String, @ViewBuilder control: () -> Control) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.callout)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            control()
        }
        .padding(14)
        .overlay(Divider(), alignment: .bottom)
    }

    private func pill(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.green)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }

    private func previewButton(_ text: String) -> some View {
        Button(text) {}
            .buttonStyle(.bordered)
            .font(.caption)
            .disabled(true)
    }
}
