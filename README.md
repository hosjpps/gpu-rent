# GPU Rent

Учебный проект сервиса аренды облачных GPU-серверов (по мотивам RunPod, Vast.ai, Immers.cloud).
Клиент пополняет баланс, выбирает модель GPU в дата-центре, запускает инстанс из шаблона
(PyTorch, Jupyter, Stable Diffusion), подключается по SSH и платит посекундно. Администратор
управляет дата-центрами, нодами, GPU и ценами, смотрит загрузку и выручку.

Проект выполняется в рамках дисциплины «Создание программного обеспечения» (РТУ МИРЭА,
Институт перспективных технологий и индустриального программирования).
Автор — Васин С. А., группа ЭФБО-17-24.

## Отчёты по практическим занятиям

| № | Тема | PDF | Исходник |
|---|---|---|---|
| 1 | Введение в дисциплину. Организация командной работы и выбор проекта | [reports/pr1.pdf](reports/pr1.pdf) | [pr1-vvedenie.md](docs/reports/pr1-vvedenie.md) |
| 2 | Анализ требований и планирование разработки монолитного веб-приложения | [reports/pr2.pdf](reports/pr2.pdf) | [pr2-trebovaniya-i-plan.md](docs/reports/pr2-trebovaniya-i-plan.md) |
| 3 | Проектирование БД: концептуальная и логическая модель | [reports/pr3.pdf](reports/pr3.pdf) | [pr3-logicheskoe-proektirovanie-bd.md](docs/reports/pr3-logicheskoe-proektirovanie-bd.md) |
| 4 | Проектирование БД: физическая реализация, оптимизация и безопасность | [reports/pr4.pdf](reports/pr4.pdf) | [pr4-fizicheskaya-realizaciya-bd.md](docs/reports/pr4-fizicheskaya-realizaciya-bd.md) |

Задания П3 и П4 по тексту совпадают, поэтому работа разделена: П3 — логическое проектирование
(сущности, ER-модель, нормализация, словарь данных), П4 — реализация в PostgreSQL 16 с замерами
`EXPLAIN ANALYZE`, ролями, RLS, шифрованием и тестами.

## Сдача практических №1–4

В `reports/` находятся четыре PDF из таблицы выше. К защите БД приложены SQL-миграции,
тестовые данные, тесты и сохранённые результаты замеров в `db/bench/results/`.
После уточнений 03.10.2026 PDF П2–П4 пересобраны из актуальных исходников: 53, 55 и 53 страницы.
Проверены сохранность текста и схем, страницы оглавления и раскладка всех страниц.
В П2–П4 есть ответы на контрольные вопросы задания. Веб-приложение относится к следующим
этапам семестра: его серверная и клиентская части пока не реализованы.

Порядок демонстрации: требования и план из П2 → ER-модель из П3 → миграции,
ограничения и тесты из П4 → сравнение планов запросов в `db/bench/results/`.
Отчёты описывают индивидуальное выполнение всех пяти ролей.

Повторная проверка 03.10.2026: все 12 миграций и сид применены в отдельной новой БД;
414 SQL-проверок и 14 конкурентных проверок прошли на целевом PostgreSQL 16.15.
Ранее тот же набор прошёл на PostgreSQL 15.14 как дополнительная проверка совместимости.
Числа замеров П4 относятся к ранее сохранённому стенду, новые замеры производительности
не проводились.

## Стек

- Сервер: Node.js 24 LTS, TypeScript, Express 4 (реализация — недели 5–6).
- Клиент: React 18 + Vite, собирается в статику, которую раздаёт Nginx (Express обслуживает только `/api`).
- СУБД: PostgreSQL 16 (`pgcrypto`, `btree_gist`, `citext`).
- Кэш и сессии: Redis 7. Деплой: Docker Compose, Nginx, TLS.

## Структура

```text
docs/reports/        отчёты П1–П4 (markdown-исходники)
docs/diagrams/src/   диаграммы PlantUML
docs/diagrams/png/   отрендеренные диаграммы
db/migrations/       SQL-миграции по порядку (NNNN_name.sql)
db/seed/             детерминированные тестовые данные (~1,2 млн записей потребления)
db/tests/            SQL-тесты и тест конкурентного доступа
db/bench/            сценарии EXPLAIN ANALYZE, результаты — в db/bench/results/
db/scripts/          reset.sh, test.sh, bench.sh
tools/               сборка отчётов (markdown → docx → pdf) и рендер диаграмм
reports/             готовые отчёты в PDF
```

## База данных

Нужен PostgreSQL 16 с расширениями `pgcrypto`, `btree_gist`, `citext` и пользователь с правами
суперпользователя кластера (скрипты создают роли `gpu_rent_owner`, `gpu_rent_app`,
`gpu_rent_analyst`). Параметры подключения — стандартные переменные `PGHOST`, `PGPORT`, `PGUSER`,
имя БД — `PGDATABASE` (по умолчанию `gpu_rent`).

```bash
bash db/scripts/reset.sh            # пересоздать БД: миграции + сид (около минуты)
bash db/scripts/reset.sh --no-seed  # только миграции
bash db/scripts/test.sh             # SQL-тесты, ненулевой код при падении
bash db/tests/concurrency.sh        # параллельные сессии: запуск инстансов, пополнение, биллинг
bash db/scripts/bench.sh            # сценарии EXPLAIN ANALYZE → db/bench/results/
```

Ключевые решения схемы:

- запрет двойного выделения GPU — `EXCLUDE USING gist (gpu_id WITH =, allocated_during WITH &&)`;
- история цен без пересечений периодов — `tstzrange` + `EXCLUDE`;
- журнал операций баланса неизменяем, `users.balance` — кэш суммы журнала, поддерживается триггером;
- `usage_records` секционирована по месяцам (BRIN по времени, partition pruning);
- изоляция клиентов — Row Level Security по контексту `app.user_id`;
- секреты окружения инстансов — `pgp_sym_encrypt`, ключ передаётся приложением и в БД не хранится.

## Сборка отчётов

Нужны Python 3 с `python-docx` и `plantuml`, LibreOffice (для PDF и оглавления).
Word-файлы создаются в `build/`, который не хранится в Git.

```bash
python3 tools/render_diagrams.py    # docs/diagrams/src/*.puml → docs/diagrams/png/
python3 tools/build_reports.py      # все отчёты → reports/prN.pdf
python3 tools/build_reports.py 2 4  # выборочно
```

Если LibreOffice недоступен, `tools/build_reports_pdf.py` экспортирует DOCX этого проекта
через ReportLab, самостоятельно строит оглавление и проверяет покрытие символов шрифтами.
Нужны `python-docx`, `reportlab`, `pillow`; для извлечения шрифтов — `pypdf` и `fonttools`
(проверено с ReportLab 5.0.1). Основные шрифты передаются явно: Times New Roman и Courier New,
каждый в обычном, полужирном и курсивном начертании. Каталог должен содержать TTF с именами
`TimesNewRomanPSMT`, `TimesNewRomanPS-BoldMT`, `TimesNewRomanPS-ItalicMT` и аналогичными
`CourierNew…`. Шрифты не включены в репозиторий.

```bash
python3 tools/build_reports.py --docx-only 2 3 4
python3 tools/build_reports_pdf.py --docx build/pr2.docx --pdf build/pr2-preview.pdf \
  --font-dir /path/to/report-fonts --symbol-font /path/to/DejaVuSans.ttf
```

`--symbol-font` разрешает только явно указанную подстановку недостающих символов, а не букв:
в текущих отчётах это ₽ и ⋈. Экспорт отказывается перезаписывать существующий PDF.
Сначала проверяйте новый файл, затем заменяйте отчёт с сохранением предыдущей версии.
Раскладка резервного экспорта может отличаться от LibreOffice: табуляции упрощены,
футер центрируется по странице; оглавление П4 занимает три страницы.

Для текущей сборки шрифты восстановлены из сохранённых **предыдущих PDF LibreOffice**:
`python3 tools/prepare_pdf_fonts.py --pdf /path/to/original/pr1.pdf /path/to/original/pr2.pdf
/path/to/original/pr3.pdf /path/to/original/pr4.pdf --output-dir /path/to/new-font-dir`.
Помощник объединяет подмножества и восстанавливает Unicode-карту, сохраняя контуры и метрики.
Он предназначен для исходных PDF LibreOffice с Mac Roman cmap; новые PDF ReportLab
не являются входом этого помощника. Для добавленных букв может потребоваться полный TTF.
