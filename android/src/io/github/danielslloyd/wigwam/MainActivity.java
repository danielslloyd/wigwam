package io.github.danielslloyd.wigwam;

import android.app.Activity;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Wigwam for Android: a full-screen WebView locked to the Wigwam site.
 * - Only pages under SITE can load in the main window (no YouTube, no admin page, no other sites).
 * - No address bar, no pop-up windows, no downloads, no long-press menus.
 * - Back runs Wigwam's own Back; it never leaves the app.
 */
public class MainActivity extends Activity {
    static final String SITE = BuildConfig.SITE;

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFFFF7ED);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " WigwamApp/1");

        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setHapticFeedbackEnabled(false);
        web.setDownloadListener((url, ua, cd, mime, len) -> { /* no downloads */ });
        web.addJavascriptInterface(new Bridge(), "WigwamApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false; // the YouTube player's own frame
                return !allowed(req.getUrl());           // true = blocked
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // Lets Wigwam's own full-screen button work inside the app.
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (customView != null) { cb.onCustomViewHidden(); return; }
                customView = view;
                customCallback = cb;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                hideSystemBars();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                if (customCallback != null) customCallback.onCustomViewHidden();
                customCallback = null;
                hideSystemBars();
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(SITE);
        hideSystemBars();
    }

    static boolean allowed(Uri u) {
        String url = u.toString();
        if (!url.startsWith(SITE)) return false;
        String path = u.getPath();
        return path == null || !path.endsWith("admin.html");
    }

    private void showOffline() {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<body style='margin:0;height:100vh;display:grid;place-items:center;background:#fff7ed;font:24px system-ui;color:#431407;text-align:center'>"
            + "<div><div style='font-size:72px'>🛖</div><p>Wigwam can't reach the internet.</p>"
            + "<button onclick=\"location.href='" + SITE + "'\" style='font:inherit;padding:16px 40px;border:0;border-radius:999px;background:#f97316;color:#fff'>Try again</button></div>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { web.getWebChromeClient().onHideCustomView(); return; }
        String url = web.getUrl();
        if (url == null || !url.startsWith(SITE)) { web.loadUrl(SITE); return; }
        web.evaluateJavascript("window.wigwamBack && window.wigwamBack()", null);
    }

    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() { web.onPause(); super.onPause(); }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // Pick up whitelist changes made while the app sat in the background.
        web.evaluateJavascript("window.wigwamResume && window.wigwamResume()", null);
    }

    @Override
    protected void onDestroy() { web.destroy(); super.onDestroy(); }

    /** Called from player.js so the screen doesn't sleep in the middle of a video. */
    class Bridge {
        @JavascriptInterface
        public void setPlaying(boolean playing) {
            runOnUiThread(() -> {
                if (playing) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
    }
}
