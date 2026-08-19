cask "muster" do
  version :latest
  sha256 :no_check

  url "https://github.com/tharunramagiri/Muster/releases/latest/download/Muster.dmg"
  name "Muster"
  desc "Electron companion for Claude Code — live roster, real-time chat, task approvals"
  homepage "https://github.com/tharunramagiri/Muster"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  app "Muster.app"

  zap trash: [
    "~/Library/Application Support/Muster",
    "~/Library/Preferences/in.muster.app.plist",
    "~/Library/Saved Application State/in.muster.app.savedState",
  ]
end
