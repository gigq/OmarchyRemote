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
        XCTAssertTrue(app.buttons["Keyboard shortcuts"].waitForExistence(timeout: 20))
    }

    private func expectWorkspace(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        let label = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: 5), "Missing workspace label: \(text)", file: file, line: line)
        XCTAssertEqual(app.state, .runningForeground, file: file, line: line)
    }

    func testPhysicalModifierKeysCycleCloseAndLauncher() {
        // XCUIAutomation sends physical keyboard events; no JavaScript dispatch.
        app.typeKey("f", modifierFlags: [.command, .shift])
        expectWorkspace("files · 1 window")
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings · 2 windows")
        app.typeKey("j", modifierFlags: .command)
        expectWorkspace("files · 2 windows")
        app.typeKey("j", modifierFlags: [.command, .shift])
        expectWorkspace("settings · 2 windows")
        app.typeKey("k", modifierFlags: .command)
        let launcher = app.searchFields["Search apps, panes and files"]
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: launcher)
        waitForExpectations(timeout: 5)
        app.typeKey("k", modifierFlags: .command)
        expectWorkspace("settings · 2 windows")
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("files · 1 window")
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("home ·")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native keyboard shortcuts survived Command W"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
    func testPhysicalFullscreenWorkspaceAndHelpKeys() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        expectWorkspace("files · 1 window")
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings · 2 windows")
        app.typeKey("f", modifierFlags: .command)
        expectWorkspace("settings · 2 windows · fullscreen")
        app.typeKey("j", modifierFlags: .command)
        expectWorkspace("files · 2 windows · fullscreen")
        app.typeKey("f", modifierFlags: .command)
        expectWorkspace("files · 2 windows · dwindle")
        app.typeKey("1", modifierFlags: .command)
        expectWorkspace("home ·")
        app.typeKey("2", modifierFlags: .command)
        expectWorkspace("files · 2 windows")
        app.typeKey("[", modifierFlags: .command)
        expectWorkspace("home ·")
        app.typeKey("]", modifierFlags: .command)
        expectWorkspace("files · 2 windows")
        app.typeKey("/", modifierFlags: .command)
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.typeKey("e", modifierFlags: .command)
        XCTAssertEqual(app.state, .runningForeground)
        app.typeKey("e", modifierFlags: .command)
        expectWorkspace("files · 2 windows")
    }

    func testPhysicalThreeWindowCycleAndAppAliases() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectWorkspace("browser · 3 windows")
        app.typeKey("j", modifierFlags: .command)
        expectWorkspace("files · 3 windows")
        app.typeKey("j", modifierFlags: [.command, .shift])
        expectWorkspace("browser · 3 windows")
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectWorkspace("browser · 3 windows")
        app.typeKey("a", modifierFlags: [.command, .shift])
        expectWorkspace("herdr · 4 windows")
        app.typeKey("d", modifierFlags: [.command, .shift])
        expectWorkspace("lazydocker · 1 window")
        app.typeKey("t", modifierFlags: .command)
        expectWorkspace("terminal · 2 windows")
    }

    func testPhysicalDirectionalKeysAndClose() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings · 2 windows")
        app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: .command)
        expectWorkspace("files · 2 windows")
        app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: .command)
        expectWorkspace("settings · 2 windows")
        app.typeKey(XCUIKeyboardKey.leftArrow, modifierFlags: [.command, .shift])
        expectWorkspace("settings · 2 windows")
        app.typeKey(XCUIKeyboardKey.rightArrow, modifierFlags: .command)
        expectWorkspace("files · 2 windows")
        app.typeKey("w", modifierFlags: .command)
        expectWorkspace("settings · 1 window")
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
        expectWorkspace("settings · 2 windows")
    }

    func testPhysicalWorkspaceMoveChords() {
        app.typeKey("f", modifierFlags: [.command, .shift])
        app.typeKey(",", modifierFlags: .command)
        expectWorkspace("settings · 2 windows")
        app.typeKey("3", modifierFlags: [.command, .option])
        expectWorkspace("settings · 1 window")
        app.typeKey("2", modifierFlags: .command)
        expectWorkspace("files · 1 window")
        app.typeKey("0", modifierFlags: .command)
        expectWorkspace("settings · 1 window")
        app.typeKey("[", modifierFlags: [.command, .shift])
        expectWorkspace("settings · 2 windows")
        app.typeKey("]", modifierFlags: [.command, .shift])
        expectWorkspace("settings · 1 window")
        app.typeKey("2", modifierFlags: [.command, .option])
        expectWorkspace("settings · 2 windows")
    }


    func testPhysicalTerminalAndBrowserFromHome() {
        app.typeKey("t", modifierFlags: .command)
        expectWorkspace("terminal · 1 window")
        app.typeKey("1", modifierFlags: .command)
        expectWorkspace("home ·")
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectWorkspace("browser · 1 window")
    }

}
