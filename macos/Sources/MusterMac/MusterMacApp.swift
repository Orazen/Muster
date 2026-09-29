// MusterMac — the native Mac prototype (M0).
//
// A real SwiftUI/AppKit conversation, daily plan, browser and memory
// interface against owned fixtures, following the reviewed design concept
// (design/native-mac-2026-09-29). This is not a web view and not a release:
// the window states plainly that it shows fixture data, every send/approval
// action is local, and no network mutation exists in this slice.
//
// Launch directly: `.build/debug/MusterMac` (see macos/README.md).

import MusterMacCore
import SwiftUI

@main
struct MusterMacApp: App {
    @StateObject private var model: PrototypeModel

    init() {
        _model = StateObject(wrappedValue: PrototypeModel.fixture())
    }

    var body: some Scene {
        WindowGroup("Muster — native prototype") {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 980, minHeight: 620)
                .preferredColorScheme(model.appearance.colorScheme)
        }
        .windowToolbarStyle(.unified)
        .commands {
            // ⌘K search, as in the concept. The prototype filters local
            // destinations only.
            CommandGroup(replacing: .newItem) {}
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        HStack(spacing: 0) {
            SidebarView()
                .frame(width: 222)
            VStack(spacing: 0) {
                ToolbarView()
                DetailView()
            }
        }
        .safeAreaInset(edge: .bottom) {
            // M0 honesty: this window renders owned fixture data. The label
            // is part of the prototype contract, not a placeholder to remove.
            HStack(spacing: 6) {
                Image(systemName: "circle.hexagongrid.fill")
                    .font(.caption2)
                Text("Fixture data — sends, approvals and memory are local to this window")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                FlowerView(colorName: nil, busy: false)
                    .frame(width: 30, height: 30)
                Text("Muster")
                    .font(.system(size: 20, weight: .semibold, design: .default))
                    .kerning(-0.5)
                Text("MAC")
                    .font(.system(size: 8, weight: .semibold))
                    .kerning(1)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.quaternary))
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 6)
            .accessibilityElement(children: .combine)

            PrimaryNavButton(destination: .today, systemImage: "sun.max", label: "Today", trailing: "\(model.includedBlockCount)")
            PrimaryNavButton(destination: .conversations, systemImage: "bubble.left.and.text.bubble.right", label: "Conversations")
            PrimaryNavButton(destination: .browser, systemImage: "globe", label: "Browser")
            PrimaryNavButton(destination: .memory, systemImage: "memorychip", label: "Memory")
            PrimaryNavButton(destination: .settings, systemImage: "gearshape", label: "Settings")

            Spacer()

            // Device status, mirroring the concept's sidebar footer.
            Button {
                model.device.macAwake.toggle()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "laptopcomputer")
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Your devices")
                            .font(.caption)
                            .foregroundStyle(.primary)
                        Text(model.hostDetail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle()
                        .fill(model.device.macAwake ? Color.green : Color.orange)
                        .frame(width: 6, height: 6)
                }
                .padding(8)
                .background(.quinary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Device status. \(model.hostLabel).")
            .accessibilityHint("Toggles the fixture sleep state.")
            .padding(.horizontal, 10)
        }
        .padding(.bottom, 12)
        .background(.bar)
    }
}

struct PrimaryNavButton: View {
    @EnvironmentObject private var model: PrototypeModel
    let destination: ViewDestination
    let systemImage: String
    let label: String
    var trailing: String?

    var body: some View {
        Button {
            model.destination = destination
        } label: {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .frame(width: 18)
                Text(label)
                    .font(.system(size: 13, weight: model.destination == destination ? .semibold : .regular))
                Spacer()
                if let trailing {
                    Text(trailing)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.quinary, in: Capsule())
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(model.destination == destination ? Color.accentColor.opacity(0.14) : .clear,
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .padding(.horizontal, 10)
        .padding(.top, 2)
        .accessibilityAddTraits(model.destination == destination ? [.isSelected] : [])
    }
}

// MARK: - Toolbar

struct ToolbarView: View {
    @EnvironmentObject private var model: PrototypeModel

    private var title: String {
        switch model.destination {
        case .today: return "Today"
        case .conversations: return "Muster"
        case .browser: return "Browser"
        case .memory: return "Memory"
        case .settings: return "Settings"
        }
    }

    private var subtitle: String {
        switch model.destination {
        case .today: return "A little room for today"
        case .conversations: return model.hostLabel
        case .browser: return "Ideas for the launch"
        case .memory: return "What matters to you"
        case .settings: return "Your workspace"
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "sun.max")
                .foregroundStyle(.secondary)
                .opacity(model.destination == .today ? 1 : 0)
            Text(title).font(.headline)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            // Where work runs: the host pill from the concept toolbar.
            Text(model.hostLabel)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.quinary, in: Capsule())
                .accessibilityIdentifier("host-pill")
            Button {
                model.contextPanelVisible.toggle()
            } label: {
                Image(systemName: model.contextPanelVisible ? "sidebar.right" : "sidebar.left")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.contextPanelVisible ? "Hide context panel" : "Show context panel")
            .accessibilityIdentifier("panel-toggle")
            Menu {
                Picker("Appearance", selection: $model.appearance) {
                    ForEach(Appearance.allCases, id: \.self) { appearance in
                        Text(appearance.rawValue.capitalized).tag(appearance)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                Image(systemName: "circle.lefthalf.filled")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("Appearance")
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
        .background(.bar)
    }
}

// MARK: - Detail routing

struct DetailView: View {
    @EnvironmentObject private var model: PrototypeModel

    var body: some View {
        switch model.destination {
        case .today:
            TodayView()
        case .conversations:
            ConversationView()
        case .browser:
            HStack(spacing: 0) {
                ConversationView()
                Divider()
                BrowserPanelView()
                    .frame(width: 380)
            }
        case .memory:
            MemoryView()
        case .settings:
            SettingsView()
        }
    }
}

#Preview {
    RootView().environmentObject(PrototypeModel.fixture())
}
