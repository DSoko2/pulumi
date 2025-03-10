// *** WARNING: this file was generated by test. ***
// *** Do not edit by hand unless you're certain you know what you are doing! ***

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Threading.Tasks;
using Pulumi.Serialization;

namespace Pulumi.Std
{
    public static class GetDictionary
    {
        public static async Task<Dictionary<string, Outputs.AnotherCustomResult>> InvokeAsync(double? a = null, InvokeOptions? invokeOptions = null)
        {
            var builder = ImmutableDictionary.CreateBuilder<string, object?>();
            builder["a"] = a;
            var args = new global::Pulumi.DictionaryInvokeArgs(builder.ToImmutableDictionary());
            return await global::Pulumi.Deployment.Instance.InvokeAsync<Dictionary<string, Outputs.AnotherCustomResult>>("std:index:GetDictionary", args, invokeOptions.WithDefaults());
        }

        public static Output<Dictionary<string, Outputs.AnotherCustomResult>> Invoke(Input<double?>? a = null, InvokeOptions? invokeOptions = null)
        {
            var builder = ImmutableDictionary.CreateBuilder<string, object?>();
            builder["a"] = a;
            var args = new global::Pulumi.DictionaryInvokeArgs(builder.ToImmutableDictionary());
            return global::Pulumi.Deployment.Instance.Invoke<Dictionary<string, Outputs.AnotherCustomResult>>("std:index:GetDictionary", args, invokeOptions.WithDefaults());
        }
    }
}
