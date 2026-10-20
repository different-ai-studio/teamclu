package expo.modules.teamclumarkdown

import android.content.Context
import android.os.Build
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.util.TypedValue
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * A markdown block as one native TextView. The width comes from React Native;
 * the height is the text's, measured here and written back into the shadow
 * node, so Yoga lays the row out without a round trip through JS.
 */
class TeamcluMarkdownView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var markdown: String = ""
  var config: MarkdownConfig? = null

  private var ready = false

  /**
   * Re-measures whenever the text lays itself out again. React Native ignores
   * a child's requestLayout, and Markwon's table rows only learn their height
   * on the first draw, then re-set the text to lay out at that height — a
   * table whose cells wrap stayed at single-line rows, overlapping, until this.
   */
  private val textView = object : TextView(context) {
    override fun requestLayout() {
      super.requestLayout()
      if (ready) post { remeasure() }
    }
  }.apply {
    includeFontPadding = false
    isFocusable = false
    setTextIsSelectable(false)
  }
  private var renderedKey: String? = null
  private var laidOutWidth = 0
  private var reportedHeight = -1

  init {
    addView(textView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    ready = true
  }

  fun update() {
    val config = config ?: return
    val key = config.key + "\u0000" + markdown
    if (key == renderedKey) return
    renderedKey = key

    textView.setTextColor(config.textColor)
    textView.setTextSize(TypedValue.COMPLEX_UNIT_SP, config.fontSize.toFloat())
    val lineHeightPx = MarkdownRenderer.sp(context, config.lineHeight)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      textView.lineHeight = lineHeightPx
    } else {
      val fontHeight = textView.paint.getFontMetricsInt(null)
      textView.setLineSpacing((lineHeightPx - fontHeight).toFloat(), 1f)
    }
    val spanned = MarkdownRenderer.render(context, config, markdown)
    // Through Markwon, not `text =`: its plugins hook the set — the table plugin
    // schedules the re-layout that gives wrapped rows their real height.
    MarkdownRenderer.markwon(context, config).setParsedMarkdown(textView, spanned)
    // Links only: a movement method makes the TextView take touches, and the
    // row's own press and long-press must still reach React Native. Set after
    // Markwon, which installs one on every text it sets.
    val hasLinks = spanned.getSpans(0, spanned.length, ClickableSpan::class.java).isNotEmpty()
    textView.movementMethod = if (hasLinks) LinkMovementMethod.getInstance() else null
    textView.isClickable = hasLinks
    textView.isLongClickable = false
    remeasure()
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    if (width != laidOutWidth) {
      laidOutWidth = width
      remeasure()
    } else {
      textView.layout(0, 0, width, textView.measuredHeight)
    }
  }

  private fun remeasure() {
    if (laidOutWidth <= 0) return
    textView.measure(
      MeasureSpec.makeMeasureSpec(laidOutWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
    )
    val height = textView.measuredHeight
    textView.layout(0, 0, laidOutWidth, height)
    invalidate()
    if (height != reportedHeight) {
      reportedHeight = height
      shadowNodeProxy.setStyleSize(null, height / resources.displayMetrics.density.toDouble())
    }
  }
}
