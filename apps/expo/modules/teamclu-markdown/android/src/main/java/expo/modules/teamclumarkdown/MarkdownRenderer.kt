package expo.modules.teamclumarkdown

import android.content.Context
import android.graphics.Paint
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.LineHeightSpan
import android.util.LruCache
import android.util.TypedValue
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tables.TableTheme

/**
 * Markdown → one Spanned, for a single TextView. Parsing and rendering are
 * native and cached: a row recycled back on screen, or a reply re-rendered with
 * the same text, costs nothing.
 */
object MarkdownRenderer {
  private val markwons = HashMap<String, Markwon>()
  private val rendered = LruCache<String, Spanned>(96)

  fun render(context: Context, config: MarkdownConfig, markdown: String): Spanned {
    val cacheKey = config.key + "\u0000" + markdown
    rendered.get(cacheKey)?.let { return it }
    val markwon = markwons.getOrPut(config.key) { build(context.applicationContext, config) }
    val spanned = tightenBlockGaps(markwon.toMarkdown(markdown), sp(context, config.blockGap))
    rendered.put(cacheKey, spanned)
    return spanned
  }

  private fun build(context: Context, config: MarkdownConfig): Markwon {
    val size = config.fontSize.toFloat()
    return Markwon.builder(context)
      .usePlugin(StrikethroughPlugin.create())
      .usePlugin(
        TablePlugin.create(
          TableTheme.Builder()
            .tableBorderColor(config.ruleColor)
            .tableBorderWidth(dp(context, 0.5))
            .tableCellPadding(dp(context, 6.0))
            .tableHeaderRowBackgroundColor(0)
            .tableEvenRowBackgroundColor(0)
            .tableOddRowBackgroundColor(0)
            .build()
        )
      )
      .usePlugin(object : AbstractMarkwonPlugin() {
        override fun configureTheme(builder: MarkwonTheme.Builder) {
          builder
            .linkColor(config.linkColor)
            .isLinkUnderlined(true)
            .codeTextColor(config.textColor)
            .codeBackgroundColor(config.surfaceColor)
            .codeBlockTextColor(config.textColor)
            .codeBlockBackgroundColor(config.surfaceColor)
            .codeBlockMargin(dp(context, 8.0))
            .blockQuoteColor(config.ruleColor)
            .blockQuoteWidth(dp(context, 3.0))
            // Indent of list items and quotes: bullets sit close to the text.
            .blockMargin(dp(context, 14.0))
            .bulletWidth(dp(context, 5.0))
            .listItemColor(config.textColor)
            .headingBreakHeight(0)
            .headingTypeface(Typeface.DEFAULT_BOLD)
            // Same steps as the JS styles: body +4 / +2 / +1, then body size.
            .headingTextSizeMultipliers(
              floatArrayOf((size + 4) / size, (size + 2) / size, (size + 1) / size, 1f, 1f, 1f)
            )
            .thematicBreakColor(config.ruleColor)
            .thematicBreakHeight(maxOf(1, dp(context, 0.5)))
        }
      })
      .build()
  }

  /**
   * Markwon separates blocks with a blank line, a full line of body height.
   * The JS renderer spaces them by `blockGap`; shrink each blank line to that.
   */
  private fun tightenBlockGaps(source: Spanned, gapPx: Int): Spanned {
    val out = SpannableStringBuilder(source)
    var i = 0
    while (i < out.length - 1) {
      if (out[i] == '\n' && out[i + 1] == '\n') {
        out.setSpan(GapLine(gapPx), i + 1, i + 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        i += 2
      } else {
        i += 1
      }
    }
    return out
  }

  private class GapLine(private val height: Int) : LineHeightSpan {
    override fun chooseHeight(
      text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt,
    ) {
      fm.top = -height
      fm.ascent = -height
      fm.descent = 0
      fm.bottom = 0
    }
  }

  fun dp(context: Context, value: Double): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), context.resources.displayMetrics).toInt()

  fun sp(context: Context, value: Double): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), context.resources.displayMetrics).toInt()
}
