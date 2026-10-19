//! Port of silk/sort.c.

/* Insertion sort (fast for already almost sorted arrays):   */
/* Best case:  O(n)   for an already sorted array            */
/* Worst case: O(n^2) for an inversely sorted array          */
/*                                                           */
/* Shell short:    https://en.wikipedia.org/wiki/Shell_sort  */

/// `a`: unsorted / sorted vector (I/O); `idx`: index vector for the sorted elements (O);
/// `L`: vector length; `K`: number of correctly sorted positions.
pub fn silk_insertion_sort_increasing(a: &mut [i32], idx: &mut [i32], L: i32, K: i32) {
    /* Safety checks */
    debug_assert!(K > 0);
    debug_assert!(L > 0);
    debug_assert!(L >= K);

    /* Write start indices in index vector */
    for i in 0..K {
        idx[i as usize] = i;
    }

    /* Sort vector elements by value, increasing order */
    for i in 1..K {
        let value = a[i as usize];
        let mut j = i - 1;
        while j >= 0 && value < a[j as usize] {
            a[(j + 1) as usize] = a[j as usize]; /* Shift value */
            idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
            j -= 1;
        }
        a[(j + 1) as usize] = value; /* Write value */
        idx[(j + 1) as usize] = i; /* Write index */
    }

    /* If less than L values are asked for, check the remaining values, */
    /* but only spend CPU to ensure that the K first values are correct */
    for i in K..L {
        let value = a[i as usize];
        if value < a[(K - 1) as usize] {
            let mut j = K - 2;
            while j >= 0 && value < a[j as usize] {
                a[(j + 1) as usize] = a[j as usize]; /* Shift value */
                idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
                j -= 1;
            }
            a[(j + 1) as usize] = value; /* Write value */
            idx[(j + 1) as usize] = i; /* Write index */
        }
    }
}

/// Only used by the fixed-point build in C (`#ifdef FIXED_POINT`); ported for completeness.
pub fn silk_insertion_sort_decreasing_int16(a: &mut [i16], idx: &mut [i32], L: i32, K: i32) {
    /* Safety checks */
    debug_assert!(K > 0);
    debug_assert!(L > 0);
    debug_assert!(L >= K);

    /* Write start indices in index vector */
    for i in 0..K {
        idx[i as usize] = i;
    }

    /* Sort vector elements by value, decreasing order */
    for i in 1..K {
        let value = a[i as usize];
        let mut j = i - 1;
        while j >= 0 && value > a[j as usize] {
            a[(j + 1) as usize] = a[j as usize]; /* Shift value */
            idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
            j -= 1;
        }
        a[(j + 1) as usize] = value; /* Write value */
        idx[(j + 1) as usize] = i; /* Write index */
    }

    /* If less than L values are asked for, check the remaining values, */
    /* but only spend CPU to ensure that the K first values are correct */
    for i in K..L {
        let value = a[i as usize];
        if value > a[(K - 1) as usize] {
            let mut j = K - 2;
            while j >= 0 && value > a[j as usize] {
                a[(j + 1) as usize] = a[j as usize]; /* Shift value */
                idx[(j + 1) as usize] = idx[j as usize]; /* Shift index */
                j -= 1;
            }
            a[(j + 1) as usize] = value; /* Write value */
            idx[(j + 1) as usize] = i; /* Write index */
        }
    }
}

/// `a`: unsorted / sorted vector (I/O); `L`: vector length.
pub fn silk_insertion_sort_increasing_all_values_int16(a: &mut [i16], L: i32) {
    /* Safety checks */
    debug_assert!(L > 0);

    /* Sort vector elements by value, increasing order */
    for i in 1..L {
        let value = a[i as usize];
        let mut j = i - 1;
        while j >= 0 && value < a[j as usize] {
            a[(j + 1) as usize] = a[j as usize]; /* Shift value */
            j -= 1;
        }
        a[(j + 1) as usize] = value; /* Write value */
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::Rng;
    mod c {
        unsafe extern "C" {
            pub fn silk_insertion_sort_increasing(a: *mut i32, idx: *mut i32, L: i32, K: i32);
            pub fn silk_insertion_sort_increasing_all_values_int16(a: *mut i16, L: i32);
        }
    }

    #[test]
    fn increasing_matches_c() {
        let mut rng = Rng::new(1);
        for t in 0..3000 {
            let l = rng.range(1, 40);
            let k = rng.range(1, l);
            let bits = [3, 8, 16, 31][t % 4];
            let a0 = rng.i32_vec(l as usize, bits);
            let (mut a1, mut a2) = (a0.clone(), a0.clone());
            let (mut i1, mut i2) = (vec![-1; l as usize], vec![-1; l as usize]);
            super::silk_insertion_sort_increasing(&mut a1, &mut i1, l, k);
            unsafe { c::silk_insertion_sort_increasing(a2.as_mut_ptr(), i2.as_mut_ptr(), l, k) };
            assert_eq!(a1, a2, "a, L={l} K={k} in={a0:?}");
            assert_eq!(i1[..k as usize], i2[..k as usize], "idx, L={l} K={k} in={a0:?}");
        }
    }

    #[test]
    fn all_values_int16_matches_c() {
        let mut rng = Rng::new(2);
        for t in 0..3000 {
            let l = rng.range(1, 40);
            let a0 = rng.i16_vec(l as usize, [2, 8, 16][t % 3]);
            let (mut a1, mut a2) = (a0.clone(), a0.clone());
            super::silk_insertion_sort_increasing_all_values_int16(&mut a1, l);
            unsafe { c::silk_insertion_sort_increasing_all_values_int16(a2.as_mut_ptr(), l) };
            assert_eq!(a1, a2, "L={l} in={a0:?}");
        }
    }

    /// `silk_insertion_sort_decreasing_int16` is only compiled in fixed-point builds of C, so
    /// the oracle does not have it. Check the first K positions against a reference sort.
    #[test]
    fn decreasing_int16_sorts() {
        let mut rng = Rng::new(3);
        for t in 0..3000 {
            let l = rng.range(1, 40);
            let k = rng.range(1, l);
            let a0 = rng.i16_vec(l as usize, [2, 8, 16][t % 3]);
            let mut a1 = a0.clone();
            let mut idx = vec![-1; l as usize];
            super::silk_insertion_sort_decreasing_int16(&mut a1, &mut idx, l, k);
            let mut r = a0.clone();
            r.sort_by(|x, y| y.cmp(x));
            assert_eq!(a1[..k as usize], r[..k as usize], "L={l} K={k} in={a0:?}");
            for s in 0..k as usize {
                assert_eq!(a0[idx[s] as usize], a1[s]);
            }
            let mut ix: Vec<i32> = idx[..k as usize].to_vec();
            ix.sort();
            ix.dedup();
            assert_eq!(ix.len(), k as usize);
        }
    }
}
