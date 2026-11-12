//! What the uninstall says, in the 11 languages of the app. The Yes / No /
//! Cancel named in `ask` are the system's own buttons, so each language names
//! them as Windows labels them. `{path}` is replaced with a folder, `{task}`
//! with the task's name, which Task Scheduler shows untranslated.

pub struct Words {
    pub title: &'static str,
    pub ask: &'static str,
    pub done: &'static str,
    pub done_kept: &'static str,
    pub done_all: &'static str,
    pub partial: &'static str,
    pub not_ours: &'static str,
    pub task_left: &'static str,
}

const EN: Words = Words {
    done: "Xenon has been removed.",
    title: "Uninstall Xenon",
    ask: "Xenon will be removed from this computer.\n\nKeep your settings, notes and widgets in case you install it again?\n\nYes: keep them.\nNo: delete them too.\nCancel: change nothing.",
    done_kept: "Xenon has been removed. Your settings, notes and widgets are kept in:\n{path}",
    done_all: "Xenon has been removed, with your settings, notes and widgets.",
    partial: "Xenon has been removed, but some files were in use and are still in:\n{path}\n\nRestart the computer, then delete that folder.",
    not_ours: "This copy of Xenon was installed with INSTALL.bat. To remove it, run UNINSTALL.bat in its folder:\n{path}",
    task_left: "Windows did not allow removing Xenon's start-up task. To remove it, open Task Scheduler as administrator and delete the task:
{task}",
};

const IT: Words = Words {
    done: "Xenon è stato rimosso.",
    title: "Disinstalla Xenon",
    ask: "Xenon verrà rimosso da questo computer.\n\nVuoi tenere impostazioni, note e widget nel caso lo reinstalli?\n\nSì: tienili.\nNo: cancella anche quelli.\nAnnulla: non cambia nulla.",
    done_kept: "Xenon è stato rimosso. Impostazioni, note e widget restano in:\n{path}",
    done_all: "Xenon è stato rimosso, insieme a impostazioni, note e widget.",
    partial: "Xenon è stato rimosso, ma alcuni file erano in uso e sono ancora in:\n{path}\n\nRiavvia il computer, poi cancella quella cartella.",
    not_ours: "Questa copia di Xenon è stata installata con INSTALL.bat. Per rimuoverla, avvia UNINSTALL.bat nella sua cartella:\n{path}",
    task_left: "Windows non ha permesso di rimuovere l'attività di avvio di Xenon. Per toglierla, apri Utilità di pianificazione come amministratore ed elimina l'attività:
{task}",
};

const KO: Words = Words {
    done: "Xenon을 제거했습니다.",
    title: "Xenon 제거",
    ask: "이 컴퓨터에서 Xenon을 제거합니다.\n\n다시 설치할 때를 위해 설정, 메모, 위젯을 남겨 둘까요?\n\n예: 남겨 둡니다.\n아니요: 함께 삭제합니다.\n취소: 아무것도 바꾸지 않습니다.",
    done_kept: "Xenon을 제거했습니다. 설정, 메모, 위젯은 다음 위치에 남아 있습니다:\n{path}",
    done_all: "Xenon을 설정, 메모, 위젯과 함께 제거했습니다.",
    partial: "Xenon을 제거했지만 사용 중이던 일부 파일이 다음 위치에 남아 있습니다:\n{path}\n\n컴퓨터를 다시 시작한 뒤 그 폴더를 삭제하세요.",
    not_ours: "이 Xenon은 INSTALL.bat으로 설치되었습니다. 제거하려면 해당 폴더의 UNINSTALL.bat을 실행하세요:\n{path}",
    task_left: "Windows에서 Xenon 시작 작업을 제거하도록 허용하지 않았습니다. 제거하려면 작업 스케줄러를 관리자 권한으로 열고 다음 작업을 삭제하세요:
{task}",
};

const JA: Words = Words {
    done: "Xenon を削除しました。",
    title: "Xenon のアンインストール",
    ask: "このコンピューターから Xenon を削除します。\n\nもう一度インストールするときのために、設定、メモ、ウィジェットを残しますか？\n\nはい: 残します。\nいいえ: それらも削除します。\nキャンセル: 何も変更しません。",
    done_kept: "Xenon を削除しました。設定、メモ、ウィジェットは次の場所に残っています:\n{path}",
    done_all: "Xenon を設定、メモ、ウィジェットとともに削除しました。",
    partial: "Xenon を削除しましたが、使用中だった一部のファイルが次の場所に残っています:\n{path}\n\nコンピューターを再起動してから、そのフォルダーを削除してください。",
    not_ours: "この Xenon は INSTALL.bat でインストールされています。削除するには、そのフォルダーの UNINSTALL.bat を実行してください:\n{path}",
    task_left: "Windows で Xenon のスタートアップ タスクを削除できませんでした。削除するには、タスク スケジューラを管理者として開き、次のタスクを削除してください:
{task}",
};

const ZH: Words = Words {
    done: "Xenon 已移除。",
    title: "卸载 Xenon",
    ask: "将从这台电脑上移除 Xenon。\n\n要保留设置、笔记和小组件，以便以后重新安装吗？\n\n是：保留。\n否：一并删除。\n取消：不做任何更改。",
    done_kept: "Xenon 已移除。设置、笔记和小组件保留在：\n{path}",
    done_all: "Xenon 已连同设置、笔记和小组件一起移除。",
    partial: "Xenon 已移除，但有些文件正在使用，仍留在：\n{path}\n\n请重启电脑，然后删除该文件夹。",
    not_ours: "这份 Xenon 是用 INSTALL.bat 安装的。要移除它，请运行其文件夹中的 UNINSTALL.bat：\n{path}",
    task_left: "Windows 未允许移除 Xenon 的启动任务。要移除它，请以管理员身份打开任务计划程序并删除此任务：
{task}",
};

const ES: Words = Words {
    done: "Xenon se ha quitado.",
    title: "Desinstalar Xenon",
    ask: "Xenon se quitará de este equipo.\n\n¿Quieres conservar los ajustes, las notas y los widgets por si lo vuelves a instalar?\n\nSí: conservarlos.\nNo: borrarlos también.\nCancelar: no cambiar nada.",
    done_kept: "Xenon se ha quitado. Los ajustes, las notas y los widgets se conservan en:\n{path}",
    done_all: "Xenon se ha quitado, junto con los ajustes, las notas y los widgets.",
    partial: "Xenon se ha quitado, pero algunos archivos estaban en uso y siguen en:\n{path}\n\nReinicia el equipo y borra esa carpeta.",
    not_ours: "Esta copia de Xenon se instaló con INSTALL.bat. Para quitarla, ejecuta UNINSTALL.bat en su carpeta:\n{path}",
    task_left: "Windows no permitió quitar la tarea de inicio de Xenon. Para quitarla, abre el Programador de tareas como administrador y elimina la tarea:
{task}",
};

const FR: Words = Words {
    done: "Xenon a été supprimé.",
    title: "Désinstaller Xenon",
    ask: "Xenon va être supprimé de cet ordinateur.\n\nGarder vos réglages, notes et widgets au cas où vous le réinstalleriez ?\n\nOui : les garder.\nNon : les supprimer aussi.\nAnnuler : ne rien changer.",
    done_kept: "Xenon a été supprimé. Vos réglages, notes et widgets sont conservés dans :\n{path}",
    done_all: "Xenon a été supprimé, avec vos réglages, notes et widgets.",
    partial: "Xenon a été supprimé, mais certains fichiers étaient utilisés et restent dans :\n{path}\n\nRedémarrez l’ordinateur, puis supprimez ce dossier.",
    not_ours: "Cette copie de Xenon a été installée avec INSTALL.bat. Pour la supprimer, lancez UNINSTALL.bat dans son dossier :\n{path}",
    task_left: "Windows n'a pas permis de supprimer la tâche de démarrage de Xenon. Pour la supprimer, ouvrez le Planificateur de tâches en tant qu'administrateur et supprimez la tâche :
{task}",
};

const DE: Words = Words {
    done: "Xenon wurde entfernt.",
    title: "Xenon deinstallieren",
    ask: "Xenon wird von diesem Computer entfernt.\n\nEinstellungen, Notizen und Widgets behalten, falls du es wieder installierst?\n\nJa: behalten.\nNein: ebenfalls löschen.\nAbbrechen: nichts ändern.",
    done_kept: "Xenon wurde entfernt. Einstellungen, Notizen und Widgets bleiben in:\n{path}",
    done_all: "Xenon wurde entfernt, zusammen mit Einstellungen, Notizen und Widgets.",
    partial: "Xenon wurde entfernt, aber einige Dateien waren in Gebrauch und liegen noch in:\n{path}\n\nStarte den Computer neu und lösche dann diesen Ordner.",
    not_ours: "Diese Xenon-Kopie wurde mit INSTALL.bat installiert. Zum Entfernen starte UNINSTALL.bat in ihrem Ordner:\n{path}",
    task_left: "Windows hat das Entfernen der Startaufgabe von Xenon nicht erlaubt. Öffne zum Entfernen die Aufgabenplanung als Administrator und lösche die Aufgabe:
{task}",
};

const PT: Words = Words {
    done: "O Xenon foi removido.",
    title: "Desinstalar o Xenon",
    ask: "O Xenon vai ser removido deste computador.\n\nManter as definições, as notas e os widgets para o caso de o voltares a instalar?\n\nSim: mantê-los.\nNão: apagá-los também.\nCancelar: não alterar nada.",
    done_kept: "O Xenon foi removido. As definições, as notas e os widgets ficam em:\n{path}",
    done_all: "O Xenon foi removido, com as definições, as notas e os widgets.",
    partial: "O Xenon foi removido, mas alguns ficheiros estavam em uso e continuam em:\n{path}\n\nReinicia o computador e depois apaga essa pasta.",
    not_ours: "Esta cópia do Xenon foi instalada com o INSTALL.bat. Para a remover, executa o UNINSTALL.bat na pasta dela:\n{path}",
    task_left: "O Windows não permitiu remover a tarefa de arranque do Xenon. Para a remover, abre o Agendador de Tarefas como administrador e elimina a tarefa:
{task}",
};

const RU: Words = Words {
    done: "Xenon удалён.",
    title: "Удаление Xenon",
    ask: "Xenon будет удалён с этого компьютера.\n\nСохранить настройки, заметки и виджеты на случай повторной установки?\n\nДа: сохранить.\nНет: удалить и их.\nОтмена: ничего не менять.",
    done_kept: "Xenon удалён. Настройки, заметки и виджеты сохранены в:\n{path}",
    done_all: "Xenon удалён вместе с настройками, заметками и виджетами.",
    partial: "Xenon удалён, но некоторые файлы были заняты и остались в:\n{path}\n\nПерезагрузите компьютер, затем удалите эту папку.",
    not_ours: "Эта копия Xenon установлена через INSTALL.bat. Чтобы удалить её, запустите UNINSTALL.bat в её папке:\n{path}",
    task_left: "Windows не разрешила удалить задачу автозапуска Xenon. Чтобы удалить её, откройте Планировщик заданий от имени администратора и удалите задачу:
{task}",
};

const NL: Words = Words {
    done: "Xenon is verwijderd.",
    title: "Xenon verwijderen",
    ask: "Xenon wordt van deze computer verwijderd.\n\nJe instellingen, notities en widgets bewaren voor als je het opnieuw installeert?\n\nJa: bewaren.\nNee: ook verwijderen.\nAnnuleren: niets wijzigen.",
    done_kept: "Xenon is verwijderd. Je instellingen, notities en widgets staan nog in:\n{path}",
    done_all: "Xenon is verwijderd, samen met je instellingen, notities en widgets.",
    partial: "Xenon is verwijderd, maar sommige bestanden waren in gebruik en staan nog in:\n{path}\n\nStart de computer opnieuw op en verwijder daarna die map.",
    not_ours: "Deze kopie van Xenon is geïnstalleerd met INSTALL.bat. Start UNINSTALL.bat in de map ervan om hem te verwijderen:\n{path}",
    task_left: "Windows stond niet toe dat de opstarttaak van Xenon werd verwijderd. Open Taakplanner als administrator en verwijder de taak:
{task}",
};

/// Every language, by the Windows primary language id (LANG_*).
pub const ALL: [(u16, &Words); 11] = [
    (0x09, &EN), (0x10, &IT), (0x12, &KO), (0x11, &JA), (0x04, &ZH), (0x0a, &ES),
    (0x0c, &FR), (0x07, &DE), (0x16, &PT), (0x19, &RU), (0x13, &NL),
];

/// The words for a Windows primary language id; English for any other.
pub fn for_language(primary: u16) -> &'static Words {
    ALL.iter().find(|(id, _)| *id == primary).map(|(_, w)| *w).unwrap_or(&EN)
}
