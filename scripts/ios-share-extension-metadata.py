#!/usr/bin/env python3
"""Check generated or packaged Share extension metadata before submission.

Uses plistlib so the same check accepts XcodeGen XML and exported binary plists.
This checks extension registration, not signing, entitlements or Apple approval.
"""
import argparse
import json
import plistlib
import sys
from pathlib import Path


def validate_metadata(info, source=False, containing_app=None):
    version_keys = {"CFBundleShortVersionString": "$(MARKETING_VERSION)", "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)"}
    for key, placeholder in version_keys.items():
        value = info.get(key)
        if source and value != placeholder:
            raise ValueError(f"{key} must use {placeholder} in generated source")
        if not source and (not isinstance(value, str) or not value or "$" in value):
            raise ValueError(f"{key} must contain a compiled version")
        if containing_app is not None and value != containing_app.get(key):
            raise ValueError(f"{key} must match the containing app")
    extension = info.get("NSExtension")
    if not isinstance(extension, dict):
        raise ValueError("missing NSExtension dictionary")
    if extension.get("NSExtensionPointIdentifier") != "com.apple.share-services":
        raise ValueError("NSExtensionPointIdentifier must be com.apple.share-services")
    principal = ("$(PRODUCT_MODULE_NAME)" if source else "MusterShareExtension") + ".ShareViewController"
    if extension.get("NSExtensionPrincipalClass") != principal:
        raise ValueError(f"NSExtensionPrincipalClass must be {principal}")
    if "NSExtensionMainStoryboard" in extension:
        raise ValueError("ShareViewController uses a principal class, not a storyboard")
    attributes = extension.get("NSExtensionAttributes")
    rule = attributes.get("NSExtensionActivationRule") if isinstance(attributes, dict) else None
    if not isinstance(rule, dict):
        raise ValueError("NSExtensionActivationRule must be a bounded dictionary")
    if set(rule) != {"NSExtensionActivationSupportsText", "NSExtensionActivationSupportsWebURLWithMaxCount"}:
        raise ValueError("Share activation must allow only text and one web URL")
    if rule["NSExtensionActivationSupportsText"] is not True:
        raise ValueError("Text activation must be true")
    count = rule["NSExtensionActivationSupportsWebURLWithMaxCount"]
    if type(count) is not int or count != 1:
        raise ValueError("Web URL activation count must be the integer 1")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plist", type=Path)
    parser.add_argument("--source", action="store_true", help="Allow the unexpanded XcodeGen module name")
    parser.add_argument("--containing-app", type=Path, help="Containing app Info.plist, to verify packaged version parity")
    arguments = parser.parse_args()
    try:
        with arguments.plist.open("rb") as stream:
            info = plistlib.load(stream)
        if not isinstance(info, dict):
            raise ValueError("Info.plist root must be a dictionary")
        containing_app = None
        if arguments.containing_app:
            if arguments.source:
                raise ValueError("--containing-app is for compiled metadata only")
            with arguments.containing_app.open("rb") as stream:
                containing_app = plistlib.load(stream)
            if not isinstance(containing_app, dict):
                raise ValueError("Containing app Info.plist root must be a dictionary")
        validate_metadata(info, arguments.source, containing_app)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print(f"Share extension metadata rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"valid": True, "kind": "source" if arguments.source else "packaged"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
