package expo.modules.teamclumarkdown

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * The palette a bubble draws with. Colours arrive as ARGB ints (`processColor`
 * on the JS side); sizes are in dp and scale with the system font size, as
 * React Native's text does.
 */
class MarkdownConfig : Record {
  @Field val textColor: Int = 0xFF000000.toInt()
  @Field val linkColor: Int = 0xFF000000.toInt()
  @Field val surfaceColor: Int = 0
  @Field val ruleColor: Int = 0xFFCCCCCC.toInt()
  @Field val fontSize: Double = 15.0
  @Field val lineHeight: Double = 20.0
  @Field val blockGap: Double = 6.0

  val key: String
    get() = "$textColor|$linkColor|$surfaceColor|$ruleColor|$fontSize|$lineHeight|$blockGap"
}
