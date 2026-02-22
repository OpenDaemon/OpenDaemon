import { describe, it, expect, beforeEach } from 'vitest';
import { Counter, Gauge, Histogram, metrics } from '../../packages/sdk/src/runtime.js';

describe('Counter', () => {
  let counter: Counter;

  beforeEach(() => {
    counter = new Counter('test_counter', 'A test counter');
  });

  it('should initialize with zero', () => {
    expect(counter.get()).toBe(0);
  });

  it('should increment by 1 by default', () => {
    counter.inc();
    expect(counter.get()).toBe(1);
  });

  it('should increment by specified value', () => {
    counter.inc({}, 5);
    expect(counter.get()).toBe(5);
  });

  it('should increment multiple times', () => {
    counter.inc();
    counter.inc();
    counter.inc();
    expect(counter.get()).toBe(3);
  });

  it('should handle labels', () => {
    counter.inc({ method: 'GET' });
    counter.inc({ method: 'POST' });
    
    expect(counter.get({ method: 'GET' })).toBe(1);
    expect(counter.get({ method: 'POST' })).toBe(1);
  });

  it('should increment with labels', () => {
    counter.inc({ method: 'GET' }, 2);
    counter.inc({ method: 'GET' }, 3);
    
    expect(counter.get({ method: 'GET' })).toBe(5);
  });

  it('should reset to zero', () => {
    counter.inc({}, 10);
    expect(counter.get()).toBe(10);
    
    counter.reset();
    expect(counter.get()).toBe(0);
  });

  it('should have name and help properties', () => {
    expect(counter.name).toBe('test_counter');
    expect(counter.help).toBe('A test counter');
  });
});

describe('Gauge', () => {
  let gauge: Gauge;

  beforeEach(() => {
    gauge = new Gauge('test_gauge', 'A test gauge');
  });

  it('should initialize with zero', () => {
    expect(gauge.get()).toBe(0);
  });

  it('should set value', () => {
    gauge.set(42);
    expect(gauge.get()).toBe(42);
  });

  it('should increment', () => {
    gauge.inc();
    expect(gauge.get()).toBe(1);
    
    gauge.inc({}, 5);
    expect(gauge.get()).toBe(6);
  });

  it('should decrement', () => {
    gauge.set(10);
    gauge.dec();
    expect(gauge.get()).toBe(9);
    
    gauge.dec({}, 3);
    expect(gauge.get()).toBe(6);
  });

  it('should handle labels', () => {
    gauge.set(10, { cpu: '0' });
    gauge.set(20, { cpu: '1' });
    
    expect(gauge.get({ cpu: '0' })).toBe(10);
    expect(gauge.get({ cpu: '1' })).toBe(20);
  });

  it('should increment with labels', () => {
    gauge.set(5, { type: 'used' });
    gauge.inc({ type: 'used' }, 3);
    
    expect(gauge.get({ type: 'used' })).toBe(8);
  });

  it('should decrement with labels', () => {
    gauge.set(10, { type: 'free' });
    gauge.dec({ type: 'free' }, 4);
    
    expect(gauge.get({ type: 'free' })).toBe(6);
  });

  it('should handle negative values', () => {
    gauge.set(-5);
    expect(gauge.get()).toBe(-5);
  });

  it('should have name and help properties', () => {
    expect(gauge.name).toBe('test_gauge');
    expect(gauge.help).toBe('A test gauge');
  });
});

describe('Histogram', () => {
  let histogram: Histogram;

  beforeEach(() => {
    histogram = new Histogram('test_histogram', 'A test histogram');
  });

  it('should observe values', () => {
    histogram.observe(0.1);
    histogram.observe(0.2);
    histogram.observe(0.3);
    
    const buckets = histogram.getBuckets();
    expect(buckets.size).toBeGreaterThan(0);
  });

  it('should calculate quantiles', () => {
    // Add some values
    for (let i = 1; i <= 100; i++) {
      histogram.observe(i);
    }
    
    expect(histogram.quantile(0.5)).toBeGreaterThan(0);
    expect(histogram.quantile(0.95)).toBeGreaterThan(0);
    expect(histogram.quantile(0.99)).toBeGreaterThan(0);
  });

  it('should handle empty histogram', () => {
    expect(histogram.quantile(0.5)).toBe(0);
    expect(histogram.quantile(0.95)).toBe(0);
  });

  it('should handle single value', () => {
    histogram.observe(42);
    expect(histogram.quantile(0.5)).toBe(42);
  });

  it('should handle labels', () => {
    histogram.observe(0.1, { method: 'GET' });
    histogram.observe(0.2, { method: 'GET' });
    histogram.observe(0.3, { method: 'POST' });
    
    const buckets = histogram.getBuckets({ method: 'GET' });
    expect(buckets.size).toBeGreaterThan(0);
  });

  it('should reset', () => {
    histogram.observe(1);
    histogram.observe(2);
    histogram.observe(3);
    
    expect(histogram.quantile(0.5)).toBeGreaterThan(0);
    
    histogram.reset();
    
    expect(histogram.quantile(0.5)).toBe(0);
  });

  it('should use custom buckets', () => {
    const customHistogram = new Histogram(
      'custom_histogram',
      'Custom buckets',
      [1, 2, 3, 4, 5]
    );
    
    customHistogram.observe(2.5);
    
    const buckets = customHistogram.getBuckets();
    expect(buckets.size).toBeGreaterThan(0);
  });

  it('should calculate correct quantile for sorted values', () => {
    histogram.observe(10);
    histogram.observe(20);
    histogram.observe(30);
    histogram.observe(40);
    histogram.observe(50);
    
    expect(histogram.quantile(0.5)).toBe(30);
    expect(histogram.quantile(0)).toBe(10);
    expect(histogram.quantile(1)).toBe(50);
  });

  it('should have name and help properties', () => {
    expect(histogram.name).toBe('test_histogram');
    expect(histogram.help).toBe('A test histogram');
  });
});

describe('MetricsRegistry', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('should create counter', () => {
    const counter = metrics.counter('requests_total', 'Total requests');
    expect(counter).toBeInstanceOf(Counter);
    expect(counter.name).toBe('requests_total');
  });

  it('should return existing counter', () => {
    const counter1 = metrics.counter('requests_total', 'Total requests');
    const counter2 = metrics.counter('requests_total', 'Total requests');
    
    expect(counter1).toBe(counter2);
  });

  it('should create gauge', () => {
    const gauge = metrics.gauge('memory_usage', 'Memory usage');
    expect(gauge).toBeInstanceOf(Gauge);
    expect(gauge.name).toBe('memory_usage');
  });

  it('should return existing gauge', () => {
    const gauge1 = metrics.gauge('memory_usage', 'Memory usage');
    const gauge2 = metrics.gauge('memory_usage', 'Memory usage');
    
    expect(gauge1).toBe(gauge2);
  });

  it('should create histogram', () => {
    const histogram = metrics.histogram('request_duration', 'Request duration');
    expect(histogram).toBeInstanceOf(Histogram);
    expect(histogram.name).toBe('request_duration');
  });

  it('should return existing histogram', () => {
    const histogram1 = metrics.histogram('request_duration', 'Request duration');
    const histogram2 = metrics.histogram('request_duration', 'Request duration');
    
    expect(histogram1).toBe(histogram2);
  });

  it('should reset all metrics', () => {
    const counter = metrics.counter('test_counter', 'Test');
    const gauge = metrics.gauge('test_gauge', 'Test');
    const histogram = metrics.histogram('test_histogram', 'Test');
    
    counter.inc({}, 10);
    gauge.set(42);
    histogram.observe(1);
    
    metrics.reset();
    
    // After reset, getting metrics should return new instances
    const newCounter = metrics.counter('test_counter', 'Test');
    const newGauge = metrics.gauge('test_gauge', 'Test');
    const newHistogram = metrics.histogram('test_histogram', 'Test');
    
    expect(newCounter.get()).toBe(0);
    expect(newGauge.get()).toBe(0);
    expect(newHistogram.quantile(0.5)).toBe(0);
  });
});
