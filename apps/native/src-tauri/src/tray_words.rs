//! What the tray menu says, in the 11 languages of the dashboard. The language is
//! the dashboard's own (prefs `language`, the copy the splash reads); `relabel`
//! rewords the open menu when the dashboard changes it, so nobody restarts to
//! read their tray. Any other language, or none yet, reads English.

use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItemKind};
use tauri::Wry;

pub struct Words {
    pub open: &'static str,
    pub show: &'static str,
    pub hide: &'static str,
    pub fullscreen: &'static str,
    pub show_on: &'static str,
    pub automatic: &'static str,
    pub phone: &'static str,
    pub cursor_guard: &'static str,
    pub focus_guard: &'static str,
    pub gpu_pin: &'static str,
    pub crash_log: &'static str,
    pub restart: &'static str,
    pub quit: &'static str,
}

const EN: Words = Words {
    open: "Open Xenon", show: "Show the dashboard", hide: "Hide the dashboard",
    fullscreen: "Full screen", show_on: "Show on", automatic: "Automatic", phone: "On my phone or tablet",
    cursor_guard: "Keep mouse on its screen", focus_guard: "Keep games focused",
    gpu_pin: "Match render GPU to screen (next launch)", crash_log: "Open crash log", restart: "Restart", quit: "Exit",
};
const IT: Words = Words {
    open: "Apri Xenon", show: "Mostra la dashboard", hide: "Nascondi la dashboard",
    fullscreen: "Schermo intero", show_on: "Mostra su", automatic: "Automatico", phone: "Sul telefono o tablet",
    cursor_guard: "Tieni il mouse sul suo schermo", focus_guard: "Lascia il focus ai giochi",
    gpu_pin: "Usa la GPU dello schermo (al prossimo avvio)", crash_log: "Apri il registro degli errori", restart: "Riavvia", quit: "Esci",
};
const KO: Words = Words {
    open: "Xenon 열기", show: "대시보드 표시", hide: "대시보드 숨기기",
    fullscreen: "전체 화면", show_on: "표시할 화면", automatic: "자동", phone: "내 휴대폰 또는 태블릿",
    cursor_guard: "마우스를 원래 화면에 유지", focus_guard: "게임 포커스 유지",
    gpu_pin: "화면에 연결된 GPU로 렌더링 (다음 실행 시)", crash_log: "오류 로그 열기", restart: "다시 시작", quit: "종료",
};
const JA: Words = Words {
    open: "Xenon を開く", show: "ダッシュボードを表示", hide: "ダッシュボードを隠す",
    fullscreen: "全画面表示", show_on: "表示する画面", automatic: "自動", phone: "スマートフォンまたはタブレット",
    cursor_guard: "マウスを元の画面に保つ", focus_guard: "ゲームのフォーカスを保つ",
    gpu_pin: "画面につながる GPU で描画 (次回起動時)", crash_log: "エラーログを開く", restart: "再起動", quit: "終了",
};
const ZH: Words = Words {
    open: "打开 Xenon", show: "显示仪表板", hide: "隐藏仪表板",
    fullscreen: "全屏", show_on: "显示在", automatic: "自动", phone: "在我的手机或平板上",
    cursor_guard: "让鼠标留在原屏幕", focus_guard: "保持游戏焦点",
    gpu_pin: "使用屏幕所连的 GPU 渲染（下次启动生效）", crash_log: "打开崩溃日志", restart: "重新启动", quit: "退出",
};
const ES: Words = Words {
    open: "Abrir Xenon", show: "Mostrar el panel", hide: "Ocultar el panel",
    fullscreen: "Pantalla completa", show_on: "Mostrar en", automatic: "Automático", phone: "En mi teléfono o tableta",
    cursor_guard: "Mantener el ratón en su pantalla", focus_guard: "Mantener el foco en los juegos",
    gpu_pin: "Usar la GPU de la pantalla (próximo inicio)", crash_log: "Abrir el registro de errores", restart: "Reiniciar", quit: "Salir",
};
const FR: Words = Words {
    open: "Ouvrir Xenon", show: "Afficher le tableau de bord", hide: "Masquer le tableau de bord",
    fullscreen: "Plein écran", show_on: "Afficher sur", automatic: "Automatique", phone: "Sur mon téléphone ou ma tablette",
    cursor_guard: "Garder la souris sur son écran", focus_guard: "Laisser le focus aux jeux",
    gpu_pin: "Utiliser le GPU de l'écran (prochain lancement)", crash_log: "Ouvrir le journal des plantages", restart: "Redémarrer", quit: "Quitter",
};
const DE: Words = Words {
    open: "Xenon öffnen", show: "Dashboard anzeigen", hide: "Dashboard ausblenden",
    fullscreen: "Vollbild", show_on: "Anzeigen auf", automatic: "Automatisch", phone: "Auf meinem Handy oder Tablet",
    cursor_guard: "Maus auf ihrem Bildschirm halten", focus_guard: "Spiele im Fokus halten",
    gpu_pin: "GPU des Bildschirms nutzen (beim nächsten Start)", crash_log: "Absturzprotokoll öffnen", restart: "Neu starten", quit: "Beenden",
};
const PT: Words = Words {
    open: "Abrir o Xenon", show: "Mostrar o painel", hide: "Ocultar o painel",
    fullscreen: "Ecrã inteiro", show_on: "Mostrar em", automatic: "Automático", phone: "No meu telemóvel ou tablet",
    cursor_guard: "Manter o rato no seu ecrã", focus_guard: "Manter o foco nos jogos",
    gpu_pin: "Usar a GPU do ecrã (no próximo arranque)", crash_log: "Abrir o registo de falhas", restart: "Reiniciar", quit: "Sair",
};
const RU: Words = Words {
    open: "Открыть Xenon", show: "Показать панель", hide: "Скрыть панель",
    fullscreen: "Во весь экран", show_on: "Показывать на", automatic: "Автоматически", phone: "На телефоне или планшете",
    cursor_guard: "Держать мышь на своём экране", focus_guard: "Не отнимать фокус у игр",
    gpu_pin: "Рисовать на GPU этого экрана (при следующем запуске)", crash_log: "Открыть журнал сбоев", restart: "Перезапустить", quit: "Выйти",
};
const NL: Words = Words {
    open: "Xenon openen", show: "Dashboard tonen", hide: "Dashboard verbergen",
    fullscreen: "Volledig scherm", show_on: "Tonen op", automatic: "Automatisch", phone: "Op mijn telefoon of tablet",
    cursor_guard: "Muis op zijn scherm houden", focus_guard: "Games de focus laten houden",
    gpu_pin: "GPU van het scherm gebruiken (volgende start)", crash_log: "Crashlog openen", restart: "Opnieuw starten", quit: "Afsluiten",
};

/// Every language, by the dashboard's code.
pub const ALL: [(&str, &Words); 11] = [
    ("en", &EN), ("it", &IT), ("ko", &KO), ("ja", &JA), ("zh", &ZH), ("es", &ES),
    ("fr", &FR), ("de", &DE), ("pt", &PT), ("ru", &RU), ("nl", &NL),
];

/// The words for a dashboard language; English for any other, or for none yet.
pub fn for_code(code: Option<&str>) -> &'static Words {
    ALL.iter().find(|(c, _)| Some(*c) == code).map(|(_, w)| *w).unwrap_or(&EN)
}

/// Every item tray.rs gives words to, by its id.
const ITEMS: [(&str, fn(&Words) -> &'static str); 13] = [
    ("xenon-menu", |w| w.open), ("show", |w| w.show), ("hide", |w| w.hide),
    ("fullscreen", |w| w.fullscreen), ("show-on", |w| w.show_on), ("place-auto", |w| w.automatic),
    ("place-phone", |w| w.phone), ("cursor-guard", |w| w.cursor_guard), ("focus-guard", |w| w.focus_guard),
    ("gpu-pin", |w| w.gpu_pin), ("crash-log", |w| w.crash_log), ("restart", |w| w.restart), ("quit", |w| w.quit),
];

static MENU: OnceLock<Menu<Wry>> = OnceLock::new();

/// The tray's menu, kept so `relabel` can reword it.
pub fn keep(menu: Menu<Wry>) {
    let _ = MENU.set(menu);
}

/// The tray in the dashboard's new language. Called from a plain thread: setting a
/// label waits on the event loop, which the signal's handler runs inside.
pub fn relabel(code: &str) {
    let Some(menu) = MENU.get() else { return };
    let words = for_code(Some(code));
    for (id, text) in ITEMS {
        let text = text(words);
        let _ = match menu.get(id) {
            Some(MenuItemKind::MenuItem(item)) => item.set_text(text),
            Some(MenuItemKind::Check(item)) => item.set_text(text),
            Some(MenuItemKind::Submenu(item)) => item.set_text(text),
            _ => Ok(()),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::{for_code, Words, ALL, EN, ITEMS};

    fn every(w: &Words) -> [&'static str; 13] {
        [w.open, w.show, w.hide, w.fullscreen, w.show_on, w.automatic, w.phone, w.cursor_guard,
         w.focus_guard, w.gpu_pin, w.crash_log, w.restart, w.quit]
    }

    #[test]
    fn every_language_says_every_item_in_its_own_words() {
        for (code, w) in ALL {
            assert!(every(w).iter().all(|t| !t.trim().is_empty()), "{code}: an empty label");
            assert!(w.open.contains("Xenon"), "{code}: the first item names Xenon");
            if code != "en" {
                assert_ne!(w.show, EN.show, "{code}: still English");
                assert_ne!(w.phone, EN.phone, "{code}: still English");
            }
        }
    }

    #[test]
    fn an_unknown_language_or_none_reads_english() {
        assert_eq!(for_code(None).open, EN.open);
        assert_eq!(for_code(Some("xx")).open, EN.open);
        assert_eq!(for_code(Some("it")).open, "Apri Xenon");
    }

    #[test]
    fn every_reworded_item_is_an_item_of_the_tray() {
        let tray = include_str!("tray.rs");
        for (id, _) in ITEMS {
            assert!(tray.contains(&format!("\"{id}\"")), "{id} is not an id in tray.rs");
        }
    }
}
