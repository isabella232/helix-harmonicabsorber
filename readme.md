onic Absorber

[Report 1](./report_2020-10-26T23-09-31.731Z/)  
[Report 2](./report_2020-11-02T20-21-41.718Z/)  
[Report 3](./report_2020-11-02T22-26-11.212Z/)  
[Report 4](./report_00004_2020-11-02T20-21-41.718Z/)  
[Report 5](./report_00005_2020-11-02T22-26-11.212Z/)  
[Report 6](./report_00006_2020-11-02T20-21-41.718Z/)  
[Report 7](./report_00007_2020-12-11T15:55:29.892Z/)  

# Next Steps

## High Prio

* Properly trim means (methodical approach as supported by literature instead of our ad-hoc solution)
* Determine method for variable sample size (just stopping once we have a
  high confidence result seems flawed and might increase the amount of false positive results)
* Collect scores of different setups during the same interval
  to reduce the impact of performance fluctuations affecting the
  machine
* Estimate mean distribution instead of confidence interval; produce 3d graphs (color as third dimension). https://www.khanacademy.org/math/ap-statistics/random-variables-ap/combining-random-variables/a/combining-random-variables-article

## Low Prio

* Rename TolerantNumber -> Interval
* Use proper standard deviation for trimmed mean
* Consider using linearly (or otherwise) weighted means 10.1080/01621459.1967.10482914
* Provide our own scoring function for lighthouse scores which produce singularities: https://github.com/GoogleChrome/lighthouse/issues/11881, https://github.com/GoogleChrome/lighthouse/issues/11882, https://github.com/GoogleChrome/lighthouse/issues/11883
* Multidimensional outlier rejection
* Correlation matrix generation?
* Gather only artifacts; lighthouse analysis in report step
* Validate that our method can actually estimate distribution parameters with a high accuracy. Paper: "Parameter estimations from gaussian measurements: When and how to use dither."

# Abandoned

* Idea: Use median instead of average of multiple scores (there may
  be some way to use fractional medians instead of discrete ones
  by calculating it based on the empirical distribution)

=> Nope, median cannot estimate discrete distributions very well. Just use (proper) trimmed means.

# Tech improvements

* Reporting needs a proper data model
* Omit unneded autits (e.g. Audit.SCORING_MODES.NOT_APPLICABLE)
* Series should be point (not sequence) oriented
* Remove unneeded dependencies
* Store all artifacts required for rerunning lighthouse

Experiment
  ExperimentGroup
    byRun : 0..100 -> LighthouseRun
      name -> Number,
    byMeasurement : name -> MeasurmentSeries
      0..100 -> Number
    allMeasurments() [0..100, name, Measurment]


Measurment
  value: Number
  derivates:
    score
    pScore

# Error estimation outline

## Goal

Our goal is to estimate the probability distribution that the median lighthouse score will
converge towards a specific median value given enough samples. This captures the idea that
we want to speed up lighthouse score measurement by reducing the number of actual lighthouse
runs: This gives us a way of finding the minimum number of runs for a certain variance.

Whether this method actually captures some underlying phenomenon is secondary for now.

Assume every subscore is normally distributed.

Let $M_n$ be the median of n lighthouse runs converging towards $M_inf$ for an infinite number of runs.
Find the interval $[a; z]$ for every probability p, such that

`$∀ p, p : [0; 1], I(p) : [a; z], p = P[M_inf > a ∧ M_inf < z]$`

that is. Informally this allows us to derive statements like "we're 90% sure the
median would end up in the interval 0.02 and 0.07 if we ran lighthouse a lot more times"
for $p=0.9, a=0.02, z=0.07$.

From this we can derive a probability distribution `$D(x) = p*$` mapping each possible score $x$ to a probability `$p*$` such that:

`$∀ p** : p, p* >= p**, I* = I(p*), x : I*$`

D assigns every score x the probability of the most likely interval x is a part of.

Best case: We have an anlytical way of determining D.

## Validation

We can use this error estimation method to perform hypothesis tests:

1. Acquire some good sample website
2. Produce some modification of said website that is expected to generate a much higher/lower performance score
3. Measure both scores along with their error; subtract the original score from the modification score along with their error; this
   should give us the distribution of the score change. Our certainty is the percentile of the distribution at zero
   and our effect size is the result of the subtraction
4. Repeat a couple of times to validate the result
5. Repeat with a smaller modification (provoking a smaller effect size)

How many lighthouse runs does it take for our certainty to be greater than one sigma; how about five?

## Implementation ideas

### Eyballing uncertainty arithmetic

Use standard statistical methods to estimate a 95% confidence interval for each of our subscores.
Run all calculations on the mean ad well as the confidence interval values.

### Proper uncertainty arithmetic

https://en.wikipedia.org/wiki/Propagation_of_uncertainty

### Something something more sophisticated based on algebras of statistical distributions

https://en.wikipedia.org/wiki/Algebra_of_random_variables

Instead of propagating uncertainty this would treat the statistical distributions themselves als
our mathematical objects. 

### Something something more sophisticated but numeric

If were lazy (or to validate our methods from above) we could determine empirical distributions and just choose a large number
of samples from those distributions and run our math on those randomized values.

This would essentially run a monte-carlo simulation…
