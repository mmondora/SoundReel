// MondropColors.swift — the palette (plain numbers in MondropKit, tested for contrast) as SwiftUI colours.

import SwiftUI

extension Color {
    init(_ rgb: RGB) {
        self.init(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }
}
