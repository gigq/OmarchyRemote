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
