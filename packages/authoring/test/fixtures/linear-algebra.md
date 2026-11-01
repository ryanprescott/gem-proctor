# Vectors and matrices

This chapter introduces the objects that the rest of the course computes with: vectors, the inner product that measures how two vectors line up, the norm that measures length, and matrices that act on vectors.

## Vectors

A vector is an ordered list of numbers. The number of entries is the size of the vector, so a vector with three entries has size 3. We write a vector as a column, for example $x = (2, -1, 2)$, and we write $x_i$ for its $i$-th entry, so here $x_1 = 2$ and $x_3 = 2$.

Two vectors of the same size can be added by adding matching entries, and a vector can be multiplied by a number by multiplying every entry. For $a = (1, 2, 3)$ and $b = (4, 0, -1)$ the sum is $a + b = (5, 2, 2)$, and twice the first vector is $2a = (2, 4, 6)$. Vectors of different sizes cannot be added.

## Inner product

The inner product of two vectors of the same size is the number $a^T b = a_1 b_1 + a_2 b_2 + \cdots + a_n b_n$. To compute it, multiply the matching entries and add up the products. The inner product is a single number, not a vector.

As a worked example, take $a = (2, -1, 2)$ and $b = (1, 4, 1)$. Then $a^T b = 2 \cdot 1 + (-1) \cdot 4 + 2 \cdot 1 = 0$. The order does not matter: $a^T b = b^T a$ for every pair of vectors.

Two vectors are called orthogonal when their inner product is zero. The vectors $a$ and $b$ above are orthogonal. A vector whose inner product with itself is zero must be the zero vector.

## Norms and distance

The norm of a vector is its length, defined by $\|a\| = \sqrt{a^T a}$. For $a = (2, -1, 2)$ we get $a^T a = 4 + 1 + 4 = 9$, so $\|a\| = 3$. A norm is never negative, and it is zero only for the zero vector.

The distance between two vectors $a$ and $b$ of the same size is the norm of their difference, $\|a - b\|$. Two vectors are close when this number is small.

Scaling a vector scales its norm by the size of the number: $\|c a\| = |c| \, \|a\|$. In particular, multiplying a vector by $-1$ does not change its norm.

## Matrices

A matrix is a rectangular array of numbers. A matrix with $m$ rows and $n$ columns is called an $m$ by $n$ matrix. Two matrices of the same size are added entry by entry, exactly as vectors are.

The product of an $m$ by $n$ matrix $A$ and an $n$ by $p$ matrix $B$ is the $m$ by $p$ matrix $C = AB$ whose entry in row $i$ and column $j$ is the inner product of row $i$ of $A$ with column $j$ of $B$. The product is only defined when the number of columns of $A$ equals the number of rows of $B$.

Matrix multiplication is not commutative. In general $AB$ and $BA$ are different matrices, and one of them may not be defined at all. It is associative, however: $(AB)C = A(BC)$.

The transpose of a matrix swaps its rows and columns. The transpose of an $m$ by $n$ matrix is an $n$ by $m$ matrix, and the transpose of a product reverses the order: $(AB)^T = B^T A^T$.
