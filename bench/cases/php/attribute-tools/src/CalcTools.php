<?php

namespace Invalid\Bench;

use Mcp\Capability\Attribute\McpTool;

class CalcTools
{
    #[McpTool(name: 'add_integers', description: 'Adds two integers.')]
    public function add(int $a, int $b): int
    {
        return $a + $b;
    }

    #[McpTool(name: 'subtract_integers', description: 'Subtracts the second integer from the first.')]
    public function subtract(int $a, int $b): int
    {
        return $a - $b;
    }
}
