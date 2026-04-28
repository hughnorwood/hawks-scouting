"""WeasyPrint invocation."""
from __future__ import annotations
from pathlib import Path

from .template import render


def render_pdf(data: dict, output_path: Path) -> None:
    """Render brief data to a PDF at output_path. Creates parent dirs as needed."""
    from weasyprint import HTML

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    html = render(data)
    HTML(string=html).write_pdf(str(output_path))
