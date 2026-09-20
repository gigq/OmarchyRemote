import XCTest

@MainActor
final class HardwareShortcutTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        app = XCUIApplication()
        // Bundled file origin cannot connect to host APIs or existing agent panes.
        app.launchArguments = ["--bundled"]
        app.launch()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 20))
    }

    private func expectWorkspace(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        let label = app.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 5), "Missing workspace label: \(text)", file: file, line: line)
        XCTAssertEqual(app.state, .runningForeground, file: file, line: line)
    }

    func testScratchpadAndActionPalette() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        expectWorkspace("files")
        app.typeKey("s", modifierFlags: [.command, .shift])
        expectWorkspace("home")
        app.typeKey("s", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("s", modifierFlags: .command)
        expectWorkspace("home")
        app.typeKey("s", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("s", modifierFlags: [.command, .shift])
        expectWorkspace("files")
        app.typeKey("k", modifierFlags: [.command, .shift])
        let search = app.searchFields["Search actions"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        app.typeText("group")
        XCTAssertEqual(search.value as? String, "group")
        XCTAssertTrue(app.buttons["Group window with next tile"].waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Scratchpad and action palette"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Done"].tap()
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("home")
    }

    func testIndependentBrowserWindowsAndFloating() {
        app.terminate()
        app.launchArguments = ["--bundled", "--browser-shortcuts-test"]
        app.launch()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 20))
        app.typeKey("b", modifierFlags: [.command, .shift])
        app.typeKey("l", modifierFlags: [.command, .shift])
        let firstLink = app.links["Open Example Domain on phone"].firstMatch
        XCTAssertTrue(firstLink.waitForExistence(timeout: 10))
        firstLink.tap()
        let original = app.webViews["hyprland.browser.page"]
        XCTAssertTrue(original.staticTexts["Example Domain"].waitForExistence(timeout: 15))
        app.typeKey("k", modifierFlags: [.command, .shift])
        let palette = app.searchFields["Search actions"]
        XCTAssertTrue(palette.waitForExistence(timeout: 5))
        app.typeText("New browser window")
        let newBrowser = app.buttons["New browser window"]
        XCTAssertTrue(newBrowser.waitForExistence(timeout: 5))
        newBrowser.tap()
        let visibleOther = app.links.matching(identifier: "Open Other Example on phone").allElementsBoundByIndex.last {
            $0.isHittable
        }
        XCTAssertNotNil(visibleOther)
        visibleOther?.staticTexts["Other Example"].tap()
        let second = app.webViews.matching(NSPredicate(format: "identifier BEGINSWITH %@", "hyprland.browser.window-"))
            .firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertTrue(second.staticTexts["Example Domain"].waitForExistence(timeout: 15))
        XCTAssertTrue(original.exists)
        XCTAssertFalse(original.frame.intersects(second.frame))
        app.typeKey("l", modifierFlags: .command)
        let address = app.textFields.matching(identifier: "Page address").allElementsBoundByIndex.last {
            $0.isHittable
        }
        XCTAssertNotNil(address)
        XCTAssertTrue((address?.value as? String)?.contains("example.org") == true)
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        app.typeKey("o", modifierFlags: [.command, .shift])
        XCTAssertTrue(second.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Independent Browser windows and floating"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.typeKey("o", modifierFlags: [.command, .shift])
        app.typeKey("j", modifierFlags: .command)
        app.typeKey("l", modifierFlags: .command)
        let firstAddress = app.textFields.matching(identifier: "Page address").allElementsBoundByIndex.first {
            $0.isHittable
        }
        XCTAssertTrue((firstAddress?.value as? String)?.contains("example.com") == true)
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        app.typeKey("w", modifierFlags: .command)
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("home")
    }

    func testCustomFloatingShortcut() {
        app.terminate()
        app.launchArguments = ["--bundled", "--browser-shortcuts-test"]
        app.launch()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 20))
        app.typeKey("b", modifierFlags: [.command, .shift])
        app.typeKey("l", modifierFlags: [.command, .shift])
        let example = app.links["Open Example Domain on phone"].firstMatch
        XCTAssertTrue(example.waitForExistence(timeout: 10))
        example.staticTexts["Example Domain"].tap()
        let page = app.webViews["hyprland.browser.page"]
        XCTAssertTrue(page.waitForExistence(timeout: 10))
        app.typeKey(",", modifierFlags: .command)
        let customize = app.buttons["Customize keyboard shortcuts"]
        XCTAssertTrue(customize.waitForExistence(timeout: 5))
        customize.tap()
        let filter = app.searchFields["Find shortcut"]
        XCTAssertTrue(filter.waitForExistence(timeout: 5))
        filter.tap()
        filter.typeText("floating")
        XCTAssertEqual(filter.value as? String, "floating")
        app.buttons["Change shortcut for Toggle floating window"].tap()
        app.typeKey("o", modifierFlags: [.command, .alternate, .shift])
        XCTAssertTrue(app.staticTexts["Shortcut saved."].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("browser")
        let tiledWidth = page.frame.width
        app.typeKey("o", modifierFlags: [.command, .alternate, .shift])
        let floated = NSPredicate { _, _ in page.frame.width < tiledWidth - 20 }
        expectation(for: floated, evaluatedWith: page)
        waitForExpectations(timeout: 5)
        let floatingWidth = page.frame.width
        app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: [.command, .alternate, .shift])
        expectation(for: NSPredicate { _, _ in page.frame.width > floatingWidth + 10 }, evaluatedWith: page)
        waitForExpectations(timeout: 5)
        app.typeKey("o", modifierFlags: [.command, .alternate, .shift])
        app.typeKey(",", modifierFlags: .command)
        customize.tap()
        filter.tap()
        filter.typeText("floating")
        XCTAssertEqual(filter.value as? String, "floating")
        app.buttons["Reset shortcut for Toggle floating window"].tap()
        XCTAssertTrue(app.staticTexts["Default restored."].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
    }

    private func openHostDirectory() {
        app.typeKey("k", modifierFlags: .command)
        let launcher = app.searchFields["Search apps, panes and files"]
        XCTAssertTrue(launcher.waitForExistence(timeout: 5))
        launcher.typeText("Manage hosts")
        let manage = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Manage hosts")).firstMatch
        XCTAssertTrue(manage.waitForExistence(timeout: 5))
        manage.tap()
        XCTAssertTrue(app.staticTexts["Your hosts"].waitForExistence(timeout: 10))
    }

    func testHostDirectoryPersistsAndDisconnects() {
        openHostDirectory()
        let oldQA = app.buttons["Remove Q"]
        if oldQA.exists { oldQA.tap() }
        let removeQA = app.buttons["Remove QA Local"]
        if removeQA.exists { removeQA.tap() }
        app.buttons["Add a host"].tap()
        let name = app.alerts["Add Host"].textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        app.typeText("QA Local")
        expectation(for: NSPredicate(format: "value == %@", "QA Local"), evaluatedWith: name)
        waitForExpectations(timeout: 5)
        let address = app.alerts["Add Host"].textFields["Address"]
        address.tap()
        app.typeText("http://127.0.0.1:9")
        expectation(for: NSPredicate(format: "value == %@", "http://127.0.0.1:9"), evaluatedWith: address)
        waitForExpectations(timeout: 5)
        app.alerts["Add Host"].buttons["Save"].tap()
        XCTAssertTrue(removeQA.waitForExistence(timeout: 5))
        let connectQA = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@ AND NOT label BEGINSWITH %@", "QA Local", "Remove")
        ).firstMatch
        connectQA.tap()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 15))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 20))
        openHostDirectory()
        XCTAssertTrue(removeQA.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Saved hosts after relaunch"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Return to current host"].tap()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 15))
        app.typeKey("k", modifierFlags: .command)
        let launcher = app.searchFields["Search apps, panes and files"]
        XCTAssertTrue(launcher.waitForExistence(timeout: 5))
        launcher.typeText("Disconnect")
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Disconnect")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your hosts"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Return to current host"].exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Your hosts"].waitForExistence(timeout: 15))
        app.typeKey("1", modifierFlags: [.command, .control])
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 15))
        openHostDirectory()
        removeQA.tap()
        XCTAssertFalse(removeQA.exists)
        app.buttons["Return to current host"].tap()
    }

    func testBrowserPhysicalShortcuts() {
        app.terminate()
        app.launchArguments = ["--bundled", "--browser-shortcuts-test"]
        app.launch()
        XCTAssertTrue(app.staticTexts["terminal"].firstMatch.waitForExistence(timeout: 20))
        app.typeKey("b", modifierFlags: [.command, .shift])
        let returnToTabs = app.buttons["Desktop tabs"].firstMatch
        if returnToTabs.waitForExistence(timeout: 2), returnToTabs.isHittable { returnToTabs.tap() }
        let example = app.links["Open Example Domain on phone"]
        XCTAssertTrue(example.waitForExistence(timeout: 10))
        example.tap()
        let page = app.webViews["hyprland.browser.page"]
        XCTAssertTrue(page.waitForExistence(timeout: 10))
        XCTAssertTrue(page.staticTexts["Example Domain"].waitForExistence(timeout: 15))
        app.typeKey("1", modifierFlags: .command)
        expectWorkspace("home")
        app.typeKey("2", modifierFlags: .command)
        expectWorkspace("browser")
        XCTAssertTrue(page.waitForExistence(timeout: 5))
        app.typeKey("l", modifierFlags: .command)
        let address = app.textFields["Page address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        app.typeText("https://example.com/#draft")
        XCTAssertEqual(address.value as? String, "https://example.com/#draft")
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        app.typeKey("l", modifierFlags: [.command, .shift])
        XCTAssertTrue(app.searchFields["Find a tab"].waitForExistence(timeout: 5))
        app.typeKey("t", modifierFlags: .control)
        XCTAssertTrue(app.staticTexts["New desktop tab"].waitForExistence(timeout: 5))
        app.typeKey(XCUIKeyboardKey.escape, modifierFlags: [])
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("home")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Browser native shortcuts complete"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testPhysicalModifierKeysCycleCloseAndLauncher() {
        // XCUIAutomation sends physical keyboard events; no JavaScript dispatch.
        app.typeKey("f", modifierFlags: [.command, .shift])
        expectWorkspace("files")
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey("j", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("j", modifierFlags: [.command, .shift])
        expectWorkspace("settings")
        app.typeKey("k", modifierFlags: .command)
        let launcher = app.searchFields["Search apps, panes and files"]
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: launcher)
        waitForExpectations(timeout: 5)
        app.typeKey("k", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("home")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native keyboard shortcuts survived Command W"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
    func testPhysicalFullscreenWorkspaceAndHelpKeys() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        expectWorkspace("files")
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey("f", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey("j", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("f", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("1", modifierFlags: .command)
        expectWorkspace("home")
        app.typeKey("2", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("[", modifierFlags: .command)
        expectWorkspace("home")
        app.typeKey("]", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("/", modifierFlags: .command)
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.typeKey("e", modifierFlags: .command)
        XCTAssertEqual(app.state, .runningForeground)
        app.typeKey("e", modifierFlags: .command)
        expectWorkspace("files")
    }

    func testPhysicalThreeWindowCycleAndAppAliases() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectWorkspace("browser")
        app.typeKey("j", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("j", modifierFlags: [.command, .shift])
        expectWorkspace("browser")
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectWorkspace("browser")
        app.typeKey("a", modifierFlags: [.command, .shift])
        expectWorkspace("herdr")
        app.typeKey("d", modifierFlags: [.command, .shift])
        expectWorkspace("lazydocker")
        app.typeKey("t", modifierFlags: .command)
        expectWorkspace("terminal")
    }

    func testPhysicalDirectionalKeysAndClose() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: [.command, .shift])
        expectWorkspace("settings")
        app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("settings")
    }

    func testEditingDoesNotRouteWindowShortcuts() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        app.typeKey("k", modifierFlags: .command)
        let search = app.searchFields["Search apps, panes and files"]
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: search)
        waitForExpectations(timeout: 5)
        search.typeText("keyboard draft")
        app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: .command)
        search.typeText("prefix ")
        XCTAssertEqual(search.value as? String, "prefix keyboard draft")
        XCTAssertTrue(search.isHittable)
        app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: .command)
        search.typeText(" suffix")
        XCTAssertEqual(search.value as? String, "prefix keyboard draft suffix")
        app.typeKey("a", modifierFlags: .command)
        search.typeText("replacement")
        XCTAssertEqual(search.value as? String, "replacement")
        XCTAssertTrue(search.isHittable)
        app.typeKey(XCUIKeyboardKey.delete, modifierFlags: .command)
        XCTAssertTrue(search.isHittable)
        app.typeKey("k", modifierFlags: .command)
        expectWorkspace("settings")
    }

    func testPhysicalWorkspaceMoveChords() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey("3", modifierFlags: [.command, .option])
        expectWorkspace("settings")
        app.typeKey("2", modifierFlags: .command)
        expectWorkspace("files")
        app.typeKey("0", modifierFlags: .command)
        expectWorkspace("settings")
        app.typeKey("[", modifierFlags: [.command, .shift])
        expectWorkspace("settings")
        app.typeKey("]", modifierFlags: [.command, .shift])
        expectWorkspace("settings")
        app.typeKey("2", modifierFlags: [.command, .option])
        expectWorkspace("settings")
    }

    func testPhysicalTerminalAndBrowserFromHome() {
        app.typeKey("t", modifierFlags: .command)
        expectWorkspace("terminal")
        app.typeKey("1", modifierFlags: .command)
        expectWorkspace("home")
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectWorkspace("browser")
    }

}
